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


def test_compile_v3_cefr_examples_exam(tmp_path: Path) -> None:
    concepts = [
        {
            "id": "WATER",
            "domain": "nature",
            "cefr": "A1",
            "pos": "noun",
            "gloss_en": "the liquid we drink",
            "rank": 1,
        },
    ]
    bundles = {"WATER": _bundle("WATER", "water", "nước")}
    examples = [("WATER", "ja", "水をください")]
    exam = (
        [("JLPT", "ja", "JLPT", 1)],
        [("JLPT", "N5", "JLPT N5", "A1", "A2", 1)],
    )
    dest = tmp_path / "lexicon-core.db"
    compile_runtime(concepts, bundles, dest=dest, examples=examples, exam=exam)
    conn = sqlite3.connect(dest)
    try:
        version = conn.execute("SELECT value FROM meta WHERE key='version'").fetchone()[0]
        cefr = conn.execute("SELECT cefr FROM concepts WHERE id='WATER'").fetchone()[0]
        domain = conn.execute("SELECT domain FROM concepts WHERE id='WATER'").fetchone()[0]
        ex = conn.execute("SELECT sentence FROM examples WHERE concept_id='WATER' AND lang='ja'").fetchone()[0]
        fw = conn.execute("SELECT COUNT(*) FROM exam_framework").fetchone()[0]
        lv = conn.execute("SELECT cefr_lo, cefr_hi, sort_no FROM exam_level WHERE framework='JLPT' AND code='N5'").fetchone()
    finally:
        conn.close()
    assert version == "3"
    assert cefr == "A1"
    assert domain == "nature"
    assert ex == "水をください"
    assert fw == 1
    assert lv == ("A1", "A2", 1)


def test_compile_v3_examples_filtered_to_known_concepts(tmp_path: Path) -> None:
    concepts = [
        {
            "id": "WATER",
            "domain": "nature",
            "cefr": "A1",
            "pos": "noun",
            "gloss_en": "the liquid we drink",
            "rank": 1,
        },
    ]
    bundles = {"WATER": _bundle("WATER", "water", "nước")}
    examples = [("WATER", "ja", "水をください"), ("GHOST_CONCEPT", "ja", "x")]
    dest = tmp_path / "lexicon-core.db"
    compile_runtime(concepts, bundles, dest=dest, examples=examples)
    conn = sqlite3.connect(dest)
    try:
        n = conn.execute("SELECT COUNT(*) FROM examples").fetchone()[0]
    finally:
        conn.close()
    assert n == 1


def test_compile_v3_optional_tables_absent_when_not_passed(tmp_path: Path) -> None:
    concepts = [
        {
            "id": "WATER",
            "domain": "nature",
            "cefr": "A1",
            "pos": "noun",
            "gloss_en": "the liquid we drink",
            "rank": 1,
        },
    ]
    bundles = {"WATER": _bundle("WATER", "water", "nước")}
    dest = tmp_path / "lexicon-core.db"
    compile_runtime(concepts, bundles, dest=dest)
    conn = sqlite3.connect(dest)
    try:
        assert conn.execute("SELECT COUNT(*) FROM examples").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM exam_level").fetchone()[0] == 0
        # cefr/domain columns exist with values from concepts
        assert conn.execute("SELECT cefr FROM concepts WHERE id='WATER'").fetchone()[0] == "A1"
    finally:
        conn.close()
