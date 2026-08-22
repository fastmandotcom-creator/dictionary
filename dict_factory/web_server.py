from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from dict_factory.languages import CEFR_LEVELS, LANGUAGE_SPECS, LANGUAGES, POS_VALUES
from dict_factory.web_queries import get_concept_detail, get_db, get_stats, search_concepts

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES_DIR = ROOT / "dict_factory" / "templates"
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

app = FastAPI(title="Dict Explorer", description="Read-only Multilingual Concept Explorer", docs_url=None)


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
