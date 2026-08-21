from __future__ import annotations

import sqlite3
from pathlib import Path

from dict_factory.compile_runtime import compile_runtime
from dict_factory.languages import LANGUAGES


def _bundle(concept_id: str, en: str, vi: str) -> dict:
    langs = {}
    for lang in LANGUAGES:
        text = en if lang == "en" else vi if lang == "vi" else f"{lang}-{concept_id}"
        langs[lang] = {
            "text": text,
            "type": "collocation" if lang == "en" else "word",
            "meaning": f"meaning-{lang}",
            "example": f"example-{lang}",
        }
    return {"concept_id": concept_id, "langs": langs}


def test_compile_writes_core_schema(tmp_path: Path) -> None:
    concepts = [
        {
            "id": "CONSUME_MEDICINE",
            "domain": "health",
            "cefr": "A1",
            "pos": "verb",
            "gloss_en": "ingest medicine",
            "rank": 1,
        },
        {
            "id": "WATER",
            "domain": "nature",
            "cefr": "A1",
            "pos": "noun",
            "gloss_en": "the liquid we drink",
            "rank": 2,
        },
    ]
    bundles = {
        "CONSUME_MEDICINE": _bundle("CONSUME_MEDICINE", "take medicine", "uống thuốc"),
        "WATER": _bundle("WATER", "water", "nước"),
    }
    dest = tmp_path / "lexicon-core.db"
    compile_runtime(concepts, bundles, dest=dest)
    conn = sqlite3.connect(dest)
    try:
        count = conn.execute("SELECT COUNT(*) FROM concepts").fetchone()[0]
        terms = conn.execute("SELECT COUNT(*) FROM terms").fetchone()[0]
        empty = conn.execute(
            "SELECT COUNT(*) FROM terms WHERE meaning IS NULL OR trim(meaning) = ''"
        ).fetchone()[0]
        pair = conn.execute(
            "SELECT text FROM terms WHERE concept_id='CONSUME_MEDICINE' AND lang='vi'"
        ).fetchone()[0]
        pos = conn.execute("SELECT pos FROM concepts WHERE id='CONSUME_MEDICINE'").fetchone()[0]
        langs = {
            row[0]
            for row in conn.execute("SELECT DISTINCT lang FROM terms").fetchall()
        }
    finally:
        conn.close()
    assert count == 2
    assert terms == 2 * 35
    assert empty == 0
    assert pair == "uống thuốc"
    assert pos == "phrase"
    assert langs == set(LANGUAGES)
