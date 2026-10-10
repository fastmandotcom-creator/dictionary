from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

from dict_factory.config import EXPRESSIONS_DIR
from dict_factory.languages import CEFR_LEVELS, CEFR_ORDER, LANGUAGES

ROMAJI_RE = re.compile(r"^[A-Za-z'’.\-]+(?:\s+[A-Za-z'’.\-]+){0,30}$")

# Unicode ranges permitted in broad IPA transcriptions: Latin base letters,
# IPA Extensions, phonetic modifiers, combining marks, Greek letters used as
# IPA symbols (β θ χ), plus brackets/space/dots. Everything else (CJK, kana,
# hangul, Arabic, Devanagari, Thai, …) is rejected: it means the LLM wrote
# orthography instead of phonetics.
_IPA_ALLOWED_RANGES = (
    (0x0020, 0x007E),  # basic Latin + [].
    (0x00A0, 0x00FF),  # Latin-1 (· etc.)
    (0x0100, 0x024F),  # Latin Extended A/B
    (0x0250, 0x02AF),  # IPA Extensions
    (0x02B0, 0x02FF),  # Spacing Modifier Letters (ˈ ˌ ː ʰ …)
    (0x0300, 0x036F),  # Combining Diacritical Marks ( ̃ tie bars …)
    (0x0370, 0x03FF),  # Greek (β θ χ used as IPA)
)


def _is_ipa_text(value: str) -> bool:
    if not value or len(value) > 96:
        return False
    return all(
        any(lo <= ord(ch) <= hi for lo, hi in _IPA_ALLOWED_RANGES) for ch in value
    )


def parse_phonetics_item(concept_id: str, lang: str, raw: Any, prompt_v: str) -> dict:
    if not isinstance(raw, dict):
        raise ValueError(f"{concept_id}/{lang}: phonetics item must be an object")
    romaji = str(raw.get("ro") or raw.get("romaji") or "").strip()
    ipa = str(raw.get("ipa") or "").strip()
    if not romaji:
        raise ValueError(f"{concept_id}/{lang}: missing romaji")
    if len(romaji) > 64 or not ROMAJI_RE.fullmatch(romaji):
        raise ValueError(f"{concept_id}/{lang}: invalid romaji {romaji!r}")
    if not _is_ipa_text(ipa):
        raise ValueError(f"{concept_id}/{lang}: invalid ipa {ipa!r} (must be IPA, not orthography)")
    return {
        "concept_id": concept_id,
        "lang": lang,
        "romaji": romaji,
        "ipa": ipa,
        "prompt_v": prompt_v,
    }


def parse_bilingual_item(concept_id: str, lang_target: str, lang_base: str, raw: Any, prompt_v: str) -> dict:
    if not isinstance(raw, dict):
        raise ValueError(f"{concept_id}/{lang_target}-{lang_base}: item must be an object")
    sent_target = str(raw.get("st") or raw.get("sent_target") or "").strip()
    sent_base = str(raw.get("sb") or raw.get("sent_base") or "").strip()
    if not sent_target or not sent_base:
        raise ValueError(f"{concept_id}: missing bilingual sentence")
    if len(sent_target) > 240 or len(sent_base) > 240:
        raise ValueError(f"{concept_id}: bilingual sentence too long")
    # Length-correlation heuristic: a true translation pair stays within the
    # same order of magnitude. Catches truncation/duplication garbage that is
    # format-valid but obviously not a translation (e.g. 100 chars vs 5).
    # Bounds are deliberately generous across scripts (CJK chars carry more
    # meaning per char than Latin ones).
    ratio = len(sent_target) / max(1, len(sent_base))
    if not 0.25 <= ratio <= 4.0:
        raise ValueError(
            f"{concept_id}: st/sb length ratio {ratio:.2f} outside [0.25, 4.0] "
            f"({len(sent_target)} vs {len(sent_base)} chars) — likely not a translation pair"
        )
    return {
        "concept_id": concept_id,
        "lang_target": lang_target,
        "lang_base": lang_base,
        "sent_target": sent_target,
        "sent_base": sent_base,
        "prompt_v": prompt_v,
    }


def parse_monolingual_item(concept_id: str, raw: Any, prompt_v: str) -> dict:
    """Parse one monolingual examples item: 35 independent sentences.

    Strict: every code in LANGUAGES must be present. Sentences are independent
    per language (NOT translations of each other) — enforced by prompt, and by
    construction there is no cross-language pairing to validate here.
    """
    if not isinstance(raw, dict):
        raise ValueError(f"{concept_id}: monolingual item must be an object")
    raw_s = raw.get("s") or raw.get("sentences")
    if not isinstance(raw_s, dict):
        raise ValueError(f"{concept_id}: missing sentences map")
    missing = [lang for lang in LANGUAGES if lang not in raw_s]
    if missing:
        raise ValueError(f"{concept_id}: missing langs {missing}")
    sentences: dict[str, str] = {}
    for lang in LANGUAGES:
        text = str(raw_s.get(lang) or "").strip()
        if len(text) < 2 or len(text) > 240:
            raise ValueError(f"{concept_id}/{lang}: sentence length out of [2, 240]")
        sentences[lang] = text
    return {"concept_id": concept_id, "sentences": sentences, "prompt_v": prompt_v}


def parse_unit(raw: Any, target: str, order_no: int, prompt_v: str) -> tuple[dict, list[dict]]:
    if not isinstance(raw, dict):
        raise ValueError("unit item must be an object")
    cefr = str(raw.get("cefr") or "").strip().upper()
    if cefr not in CEFR_LEVELS:
        raise ValueError(f"unit {order_no}: invalid cefr {cefr!r}")
    title = raw.get("title")
    if not isinstance(title, str) or not title.strip():
        title = raw.get("title_json")
    if isinstance(title, dict):
        title_map: dict[str, str] = {k: str(v).strip()[:80] for k, v in title.items() if k in LANGUAGES}
        if not title_map:
            raise ValueError(f"unit {order_no}: empty title map")
    elif isinstance(title, str) and title.strip():
        title_map = {target: title.strip()[:80]}
    else:
        raise ValueError(f"unit {order_no}: missing title")
    ids = raw.get("ids") or raw.get("concepts")
    if not isinstance(ids, list) or not ids:
        raise ValueError(f"unit {order_no}: empty concept ids")
    items = []
    seen: set[str] = set()
    for offset, cid in enumerate(ids):
        cid = str(cid).strip()
        if not cid or cid in seen:
            continue
        seen.add(cid)
        items.append({"unit_id": f"{target}-{cefr}-{order_no:02d}", "concept_id": cid, "order_no": offset + 1})
    if not items:
        raise ValueError(f"unit {order_no}: no valid concept ids")
    norm_ids = {re.sub(r"[\s_\-]+", "", cid.upper()) for cid in seen}
    for title_text in title_map.values():
        if re.sub(r"[\s_\-]+", "", title_text.upper()) in norm_ids:
            raise ValueError(
                f"unit {order_no}: title {title_text!r} is just a concept id — must describe the shared theme"
            )
    unit = {
        "id": f"{target}-{cefr}-{order_no:02d}",
        "target": target,
        "cefr": cefr,
        "order_no": order_no,
        "title_json": json.dumps(title_map, ensure_ascii=False),
        "prompt_v": prompt_v,
    }
    return unit, items


def load_phonetics(conn: sqlite3.Connection, dest_dir: Path | None = None, lang: str | None = None) -> int:
    root = Path(dest_dir) if dest_dir is not None else (EXPRESSIONS_DIR / "phonetics")
    written = 0
    files: list[Path] = []
    if root.is_dir():
        if lang is None:
            files = sorted(root.glob("*.json")) + sorted(root.glob("*/*.json"))
        else:
            files = sorted((root / lang).glob("*.json"))
    for path in files:
        raw = json.loads(path.read_text(encoding="utf-8"))
        concept_id = str(raw.get("concept_id") or "").strip()
        row_lang = str(raw.get("lang") or raw.get("l") or "").strip()
        if not concept_id or not row_lang:
            continue
        try:
            item = parse_phonetics_item(concept_id, row_lang, raw.get("data") or raw, str(raw.get("prompt_v") or "v1"))
        except ValueError as exc:
            print(f"phonetics skip {path.name}: {exc}", flush=True)
            continue
        if conn.execute("SELECT 1 FROM concepts WHERE id = ?", (concept_id,)).fetchone() is None:
            print(f"phonetics skip {path.name} (concept {concept_id} not in concepts)", flush=True)
            continue
        conn.execute(
            "INSERT OR REPLACE INTO phonetics_text(concept_id, lang, romaji, ipa, prompt_v) VALUES(?,?,?,?,?)",
            (item["concept_id"], item["lang"], item["romaji"], item["ipa"], item["prompt_v"]),
        )
        written += 1
    conn.commit()
    return written


def load_examples_bilingual(conn: sqlite3.Connection, dest_dir: Path | None = None) -> int:
    root = Path(dest_dir) if dest_dir is not None else (EXPRESSIONS_DIR / "examples_bilingual")
    written = 0
    files: list[Path] = []
    if root.is_dir():
        files = sorted(root.glob("*.json")) + sorted(root.glob("*/*.json")) + sorted(root.glob("*/*/*.json"))
    for path in files:
        raw = json.loads(path.read_text(encoding="utf-8"))
        concept_id = str(raw.get("concept_id") or "").strip()
        lang_target = str(raw.get("lang_target") or raw.get("t") or "").strip()
        lang_base = str(raw.get("lang_base") or raw.get("b") or "").strip()
        if not concept_id or not lang_target or not lang_base:
            continue
        try:
            item = parse_bilingual_item(
                concept_id, lang_target, lang_base, raw.get("data") or raw, str(raw.get("prompt_v") or "v1")
            )
        except ValueError as exc:
            print(f"examples_bilingual skip {path.name}: {exc}", flush=True)
            continue
        conn.execute(
            "INSERT OR REPLACE INTO examples_bilingual(concept_id, lang_target, lang_base, sent_target, sent_base, prompt_v) "
            "VALUES(?,?,?,?,?,?)",
            (
                item["concept_id"],
                item["lang_target"],
                item["lang_base"],
                item["sent_target"],
                item["sent_base"],
                item["prompt_v"],
            ),
        )
        written += 1
    conn.commit()
    return written


def load_units(conn: sqlite3.Connection, dest_dir: Path | None = None) -> int:
    root = Path(dest_dir) if dest_dir is not None else (EXPRESSIONS_DIR / "units")
    written = 0
    known = {r[0] for r in conn.execute("SELECT id FROM concepts")}
    for path in sorted(root.glob("*/*.json")):
        target = path.parent.name
        raw = json.loads(path.read_text(encoding="utf-8"))
        order_no = int(raw.get("order_no") or 0)
        try:
            unit, items = parse_unit(raw, target, order_no, str(raw.get("prompt_v") or "v1"))
        except ValueError as exc:
            print(f"units skip {path.name}: {exc}", flush=True)
            continue
        if unit["target"] != target:
            continue
        conn.execute(
            "INSERT OR REPLACE INTO units(id, target, cefr, order_no, title_json, prompt_v) VALUES(?,?,?,?,?,?)",
            (unit["id"], unit["target"], unit["cefr"], unit["order_no"], unit["title_json"], unit["prompt_v"]),
        )
        for item in items:
            if item["concept_id"] not in known:
                print(f"units skip {item['concept_id']} (not in concepts)", flush=True)
                continue
            conn.execute(
                "INSERT OR REPLACE INTO unit_items(unit_id, concept_id, order_no, prompt_v) VALUES(?,?,?,?)",
                (item["unit_id"], item["concept_id"], item["order_no"], unit["prompt_v"]),
            )
        written += 1
    conn.commit()
    return written


def _ensure_examples_prompt_v(conn: sqlite3.Connection) -> None:
    """Legacy `examples` table has no prompt_v column — add it idempotently."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(examples)")}
    if "prompt_v" not in cols:
        conn.execute("ALTER TABLE examples ADD COLUMN prompt_v TEXT NOT NULL DEFAULT 'v0'")
        conn.commit()


def load_examples(conn: sqlite3.Connection, dest_dir: Path | None = None) -> int:
    """Load monolingual per-language example sentences into `examples`.

    Stage files live in EXPRESSIONS_DIR/"examples_mono"/{concept_id}.json with
    {"concept_id", "prompt_v", "data": {"s": {lang: sentence}}}.
    """
    _ensure_examples_prompt_v(conn)
    root = Path(dest_dir) if dest_dir is not None else (EXPRESSIONS_DIR / "examples_mono")
    written = 0
    files: list[Path] = []
    if root.is_dir():
        files = sorted(root.glob("*.json"))
    known = {r[0] for r in conn.execute("SELECT id FROM concepts")}
    for path in files:
        raw = json.loads(path.read_text(encoding="utf-8"))
        concept_id = str(raw.get("concept_id") or "").strip()
        if not concept_id:
            continue
        if concept_id not in known:
            print(f"examples_mono skip {path.name} (concept {concept_id} not in concepts)", flush=True)
            continue
        try:
            item = parse_monolingual_item(concept_id, raw.get("data") or raw, str(raw.get("prompt_v") or "v1"))
        except ValueError as exc:
            print(f"examples_mono skip {path.name}: {exc}", flush=True)
            continue
        for lang, sentence in item["sentences"].items():
            conn.execute(
                "INSERT INTO examples(concept_id, lang, sentence, prompt_v) VALUES(?,?,?,?) "
                "ON CONFLICT(concept_id, lang) DO UPDATE SET sentence=excluded.sentence, prompt_v=excluded.prompt_v",
                (concept_id, lang, sentence, item["prompt_v"]),
            )
            written += 1
    conn.commit()
    return written


def load_phonetics_map(conn: sqlite3.Connection) -> dict[tuple[str, str], str]:
    """(concept_id, lang) -> romaji for the runtime `terms.readings` column.

    Returns an empty map when the warehouse has no phonetics filled yet.
    """
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "phonetics_text" not in tables:
        return {}
    return {
        (row[0], row[1]): row[2]
        for row in conn.execute("SELECT concept_id, lang, romaji FROM phonetics_text")
    }


def parse_exam_level(framework: str, allowed_codes: list[str], allowed_sources: set[str], raw: Any, prompt_v: str) -> dict:
    if not isinstance(raw, dict):
        raise ValueError(f"{framework}: exam level must be an object")
    if str(raw.get("framework") or "").strip() != framework:
        raise ValueError(f"{framework}: row framework mismatch {raw.get('framework')!r}")
    code = str(raw.get("code") or "").strip()
    if code not in allowed_codes:
        raise ValueError(f"{framework}: code {code!r} not in closed enum")
    label = str(raw.get("label") or "").strip()
    if not label:
        raise ValueError(f"{framework}/{code}: missing label")
    lo = str(raw.get("cefr_lo") or "").strip().upper()
    hi = str(raw.get("cefr_hi") or "").strip().upper()
    if lo not in CEFR_LEVELS or hi not in CEFR_LEVELS:
        raise ValueError(f"{framework}/{code}: CEFR range {lo!r}-{hi!r} outside enum")
    if CEFR_ORDER[lo] > CEFR_ORDER[hi]:
        raise ValueError(f"{framework}/{code}: inverted range {lo}-{hi}")
    try:
        sort_no = int(raw.get("sort_no"))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{framework}/{code}: bad sort_no") from exc
    source = str(raw.get("source") or "").strip()
    if source not in allowed_sources:
        raise ValueError(f"{framework}/{code}: source {source!r} not allowlisted")
    return {
        "framework": framework,
        "code": code,
        "label": label,
        "cefr_lo": lo,
        "cefr_hi": hi,
        "sort_no": sort_no,
        "source": source,
        "prompt_v": prompt_v,
    }


def validate_exam_table(framework: str, rows: list[dict]) -> list[dict]:
    """Table-level gates: monotonic sort, contiguous CEFR coverage, sane overlap.

    Coverage must be ONE unbroken interval (no holes inside), but need not
    span all of A1-C1: real frameworks bottom out higher (IELTS ≈ B1,
    TOEIC ≈ A2, CELPE-Bras ≈ B1). Exam filters simply match nothing below
    the framework floor.
    """
    if not rows:
        raise ValueError(f"{framework}: empty level table")
    ordered = sorted(rows, key=lambda r: r["sort_no"])
    if [r["sort_no"] for r in ordered] != list(range(1, len(ordered) + 1)):
        raise ValueError(f"{framework}: sort_no must run 1..{len(ordered)} with no gaps")
    covered: set[str] = set()
    order = sorted(CEFR_ORDER, key=lambda k: CEFR_ORDER[k])
    for row in ordered:
        covered.update(order[order.index(row["cefr_lo"]) : order.index(row["cefr_hi"]) + 1])
    span = order[order.index(min(covered, key=lambda k: CEFR_ORDER[k])) : order.index(max(covered, key=lambda k: CEFR_ORDER[k])) + 1]
    if set(span) != covered:
        raise ValueError(f"{framework}: coverage {sorted(covered)} has holes inside")
    for prev, nxt in zip(ordered, ordered[1:]):
        if CEFR_ORDER[nxt["cefr_lo"]] < CEFR_ORDER[prev["cefr_lo"]] or CEFR_ORDER[nxt["cefr_hi"]] < CEFR_ORDER[prev["cefr_hi"]]:
            raise ValueError(f"{framework}: non-monotonic ranges {prev['code']} then {nxt['code']}")
    return ordered


def load_exam_levels(conn: sqlite3.Connection, dest_dir: Path | None = None) -> int:
    from dict_factory.exam_levels import EXAM_FRAMEWORKS, EXAM_SOURCES

    root = Path(dest_dir) if dest_dir is not None else (EXPRESSIONS_DIR / "exam_levels")
    written = 0
    files: list[Path] = []
    if root.is_dir():
        files = sorted(root.glob("*.json"))
    for path in files:
        raw = json.loads(path.read_text(encoding="utf-8"))
        framework = str(raw.get("framework") or "").strip()
        spec = EXAM_FRAMEWORKS.get(framework)
        if spec is None:
            print(f"exam_levels skip {path.name}: unknown framework {framework!r}", flush=True)
            continue
        data = raw.get("data")
        if not isinstance(data, list):
            print(f"exam_levels skip {path.name}: data must be a list", flush=True)
            continue
        try:
            rows = [
                parse_exam_level(framework, spec["levels"], EXAM_SOURCES, item, str(raw.get("prompt_v") or "v1"))
                for item in data
            ]
            if {r["code"] for r in rows} != set(spec["levels"]):
                raise ValueError(f"{framework}: must emit exactly the closed enum {spec['levels']}")
            rows = validate_exam_table(framework, rows)
        except ValueError as exc:
            print(f"exam_levels skip {path.name}: {exc}", flush=True)
            continue
        conn.execute(
            "INSERT INTO exam_framework(code, lang, name, version) VALUES(?,?,?,?) "
            "ON CONFLICT(code) DO UPDATE SET lang=excluded.lang, name=excluded.name, version=excluded.version",
            (framework, spec["lang"], spec["name"], 1),
        )
        conn.execute("DELETE FROM exam_level WHERE framework = ?", (framework,))
        for row in rows:
            conn.execute(
                "INSERT INTO exam_level(framework, code, label, cefr_lo, cefr_hi, sort_no, source, prompt_v) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (row["framework"], row["code"], row["label"], row["cefr_lo"], row["cefr_hi"], row["sort_no"], row["source"], row["prompt_v"]),
            )
            written += 1
    conn.commit()
    return written
