from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.templating import Jinja2Templates

from dict_factory.languages import CEFR_LEVELS, LANGUAGE_SPECS, LANGUAGES, POS_VALUES
from dict_factory.exam_levels import (
    cefr_range_levels,
    exam_framework_lang,
    list_exam_levels,
    resolve_exam_range,
)
from dict_factory.learn_queries import learn_concept_pair, learn_level_units, learn_neighbors
from dict_factory.web_queries import get_concept_detail, get_db, get_stats, search_concepts

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES_DIR = ROOT / "dict_factory" / "templates"
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

app = FastAPI(title="Dict Explorer", description="Read-only Multilingual Concept Explorer", docs_url=None)


@app.get("/srs.js")
async def srs_js():
    """Shared client-side SRS module (intervals, due/done rules, storage keys)."""
    return FileResponse(TEMPLATES_DIR / "srs.js", media_type="text/javascript")


@app.get("/api/learn/{concept_id}")
async def api_learn_concept(concept_id: str, base: str = Query("vi"), target: str = Query("ja")):
    _validate_pair(base, target)
    conn = get_db()
    try:
        detail = learn_concept_pair(conn, concept_id, base, target)
        if detail:
            detail["neighbors"] = learn_neighbors(conn, concept_id, target)
    finally:
        conn.close()
    if not detail:
        raise HTTPException(status_code=404, detail=f"Concept {concept_id} not found")
    return detail


def _language_name(code: str) -> str:
    for spec in LANGUAGE_SPECS:
        if spec[0] == code:
            return spec[1]
    return code


def _validate_pair(base: str, target: str) -> None:
    if base not in LANGUAGES or target not in LANGUAGES:
        raise HTTPException(status_code=400, detail=f"unsupported lang pair base={base!r} target={target!r}")


def _validate_cefr(cefr: str) -> None:
    if cefr and cefr not in CEFR_LEVELS:
        raise HTTPException(status_code=400, detail=f"unknown CEFR level {cefr!r}")


def _validate_exam(conn, exam: str, target: str) -> tuple[str, str] | None:
    """Resolve ?exam=FW_CODE to a CEFR range for `target`. None when no exam.

    Rejects (400) both unknown refs and refs whose framework language does not
    match the selected target (e.g. HSK_4 on a vi->ja page).
    """
    if not exam:
        return None
    resolved = resolve_exam_range(conn, exam)
    if resolved is None:
        raise HTTPException(status_code=400, detail=f"unknown exam level {exam!r}")
    exam_lang = exam_framework_lang(conn, exam)
    if exam_lang is not None and exam_lang != target:
        raise HTTPException(
            status_code=400,
            detail=f"exam {exam!r} is for {exam_lang!r}, not target {target!r}",
        )
    return resolved


@app.get("/", response_class=HTMLResponse)
@app.head("/", response_class=HTMLResponse)
async def index(
    request: Request,
    q: str = Query("", description="Search term or meaning"),
    lang: str = Query("", description="Filter by language"),
    cefr: str = Query("", description="CEFR Level"),
    pos: str = Query("", description="Part of Speech"),
    domain: str = Query("", description="Domain"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=10, le=100),
):
    if lang and lang not in LANGUAGES:
        raise HTTPException(status_code=400, detail=f"unknown language {lang!r}")
    _validate_cefr(cefr)
    if pos and pos not in POS_VALUES:
        raise HTTPException(status_code=400, detail=f"unknown part of speech {pos!r}")
    conn = get_db()
    try:
        items, total = search_concepts(
            conn, q=q, lang=lang, cefr=cefr, pos=pos, domain=domain, page=page, page_size=page_size
        )
        stats = get_stats(conn)
        domains_list = [d["domain"] for d in stats["domains"]]
    finally:
        conn.close()

    total_pages = max(1, (total + page_size - 1) // page_size)

    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
            "q": q,
            "selected_lang": lang,
            "selected_cefr": cefr,
            "selected_pos": pos,
            "selected_domain": domain,
            "cefr_levels": sorted(CEFR_LEVELS),
            "pos_values": sorted(POS_VALUES),
            "language_specs": LANGUAGE_SPECS,
            "stats": stats,
            "domains_list": domains_list,
        },
    )


@app.get("/concept/{concept_id}", response_class=HTMLResponse)
@app.head("/concept/{concept_id}", response_class=HTMLResponse)
async def concept_view(request: Request, concept_id: str):
    conn = get_db()
    try:
        detail = get_concept_detail(conn, concept_id)
    finally:
        conn.close()

    if not detail:
        raise HTTPException(status_code=404, detail=f"Concept {concept_id} not found")

    lang_map = {spec[0]: spec for spec in LANGUAGE_SPECS}

    return templates.TemplateResponse(
        request=request,
        name="concept.html",
        context={
            "concept": detail["concept"],
            "expressions": detail["expressions"],
            "lang_map": lang_map,
        },
    )


@app.get("/api/concept/{concept_id}")
async def api_concept_detail(concept_id: str):
    conn = get_db()
    try:
        detail = get_concept_detail(conn, concept_id)
    finally:
        conn.close()

    if not detail:
        raise HTTPException(status_code=404, detail="Concept not found")
    return detail


@app.get("/onboarding", response_class=HTMLResponse)
@app.head("/onboarding", response_class=HTMLResponse)
async def onboarding(
    request: Request,
    base: str = Query("vi", description="preselect learner's language"),
    target: str = Query("ja", description="preselect target language"),
):
    _validate_pair(base, target)
    from dict_factory.db import get_db as _db
    from dict_factory.exam_levels import _has_exam_tables

    exam_by_lang: dict[str, list[str]] = {}
    conn = _db()
    try:
        if _has_exam_tables(conn):
            for row in conn.execute("SELECT lang, code FROM exam_framework ORDER BY lang, code"):
                exam_by_lang.setdefault(row["lang"], []).append(row["code"])
    finally:
        conn.close()

    return templates.TemplateResponse(
        request=request,
        name="onboarding.html",
        context={
            "language_specs": LANGUAGE_SPECS,
            "cefr_levels": sorted(CEFR_LEVELS),
            "exam_by_lang": exam_by_lang,
            "sel_base": base,
            "sel_target": target,
        },
    )


@app.get("/learn", response_class=HTMLResponse)
@app.head("/learn", response_class=HTMLResponse)
async def learn(
    request: Request,
    base: str = Query("vi", description="learner's language"),
    target: str = Query("ja", description="language being learned"),
    cefr: str = Query("", description="filter CEFR level"),
    exam: str = Query("", description="filter by exam level, e.g. JLPT_N3 (overrides cefr)"),
):
    _validate_pair(base, target)
    _validate_cefr(cefr)
    conn = get_db()
    try:
        exam_levels = list_exam_levels(conn, target)
        exam_range = _validate_exam(conn, exam, target)
        if exam_range is not None:
            levels = cefr_range_levels(*exam_range)
            units: list = []
            for level in levels:
                units.extend(learn_level_units(conn, base, target, level))
        else:
            units = learn_level_units(conn, base, target, cefr)
    finally:
        conn.close()

    units_with_title = []
    for unit in units:
        title_map = json.loads(unit["title_json"])
        title = title_map.get(base) or title_map.get("en") or unit["id"]
        concept_ids = unit["concept_ids"]
        units_with_title.append(
            {
                "id": unit["id"],
                "cefr": unit["cefr"],
                "order_no": unit["order_no"],
                "title": title,
                "count": len(concept_ids),
                "first": concept_ids[0] if concept_ids else "",
                "concept_ids": concept_ids,
            }
        )
    # Carried context for card links: exam wins over cefr (matches /learn/{id}).
    extra_qs = f"&exam={exam}" if exam else (f"&cefr={cefr}" if cefr else "")
    return templates.TemplateResponse(
        request=request,
        name="learn.html",
        context={
            "base": base,
            "target": target,
            "base_name": _language_name(base),
            "target_name": _language_name(target),
            "cefr": cefr,
            "cefr_levels": sorted(CEFR_LEVELS),
            "exam": exam,
            "exam_levels": exam_levels,
            "units": units_with_title,
            "units_available": bool(units_with_title),
            "extra_qs": extra_qs,
        },
    )


@app.get("/learn/{concept_id}", response_class=HTMLResponse)
@app.head("/learn/{concept_id}", response_class=HTMLResponse)
async def learn_concept_view(
    request: Request,
    concept_id: str,
    base: str = Query("vi"),
    target: str = Query("ja"),
    cefr: str = Query("", description="CEFR filter carried from the list page"),
    exam: str = Query("", description="exam filter carried from the list page, e.g. JLPT_N3"),
):
    _validate_pair(base, target)
    _validate_cefr(cefr)
    conn = get_db()
    neighbors: dict = {"prev": None, "next": None, "unit_id": None}
    try:
        if exam:
            _validate_exam(conn, exam, target)
        detail = learn_concept_pair(conn, concept_id, base, target)
        if detail:
            neighbors = learn_neighbors(conn, concept_id, target)
    finally:
        conn.close()

    if not detail:
        raise HTTPException(status_code=404, detail=f"Concept {concept_id} not found")

    # Carried context for back-navigation: exam wins over cefr (matches /learn).
    extra = f"&exam={exam}" if exam else (f"&cefr={cefr}" if cefr else "")
    return templates.TemplateResponse(
        request=request,
        name="learn_card.html",
        context={
            "detail": detail,
            "neighbor_prev": neighbors["prev"],
            "neighbor_next": neighbors["next"],
            "base": base,
            "target": target,
            "cefr": cefr,
            "exam": exam,
            "extra_qs": extra,
            "base_name": _language_name(base),
            "target_name": _language_name(target),
        },
    )


@app.get("/review", response_class=HTMLResponse)
@app.head("/review", response_class=HTMLResponse)
async def review(
    request: Request,
    base: str = Query("vi", description="learner's language"),
    target: str = Query("ja", description="language being learned"),
    cefr: str = Query("", description="CEFR level filter; empty = all levels"),
    exam: str = Query("", description="exam level filter, e.g. JLPT_N3 (overrides cefr)"),
):
    _validate_pair(base, target)
    _validate_cefr(cefr)
    conn = get_db()
    try:
        exam_range = _validate_exam(conn, exam, target)
        if exam_range is not None:
            levels = cefr_range_levels(*exam_range)
        elif cefr:
            levels = [cefr]
        else:
            levels = list(CEFR_LEVELS)
        units: list = []
        for level in levels:
            units.extend(learn_level_units(conn, base, target, level))
        card_ids: list[str] = []
        for unit in units:
            card_ids.extend(unit["concept_ids"][:12])
    finally:
        conn.close()

    return templates.TemplateResponse(
        request=request,
        name="review.html",
        context={
            "base": base,
            "target": target,
            "cefr": cefr,
            "exam": exam,
            "base_name": _language_name(base),
            "target_name": _language_name(target),
            "card_ids": card_ids[:120],
            "cefr_levels": sorted(CEFR_LEVELS),
        },
    )
