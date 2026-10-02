from __future__ import annotations

import json
import sqlite3

import pytest

from dict_factory.db import init_schema
from dict_factory.extra_data import (
    load_examples,
    parse_bilingual_item,
    parse_monolingual_item,
)
from dict_factory.learn_queries import learn_concept_pair
from dict_factory.prompts import SchemaViolation, load_prompt, validate_payload


@pytest.fixture
def conn_mono(tmp_path) -> sqlite3.Connection:
    db = tmp_path / "t.db"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    conn.execute(
        "INSERT INTO concepts(id, domain, cefr, pos, gloss_en, rank) VALUES "
        "('GREET_HELLO','social','A1','phrase','say hello',1)"
    )
    conn.execute(
        "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) "
        "VALUES('GREET_HELLO','ja','こんにちは','word','g')"
    )
    conn.commit()
    return conn


def _mono_raw() -> dict:
    return {
        "id": "GREET_HELLO",
        "s": {
            "en": "Hello!",
            "ja": "こんにちは。",
            "vi": "Xin chào!",
        },
    }


def test_monolingual_prompt_renders_and_validates() -> None:
    prompt = load_prompt(
        "examples_monolingual",
        variables={"concepts_block": "- GREET_HELLO | A1 | ...", "count": 1},
    )
    assert prompt.schema.get("title") == "examples_monolingual.v1"
    assert "Do NOT translate" in prompt.system
    assert "SAME situation" in prompt.system or "same situation" in prompt.system.lower()
    # no hardcoded pair in system text
    assert "->" not in prompt.system


def test_monolingual_schema_rejects_short_map() -> None:
    with pytest.raises(SchemaViolation):
        validate_payload("examples_monolingual", [{"id": "GREET_HELLO", "s": {"en": "Hi"}}])


def test_parse_monolingual_requires_all_35_langs() -> None:
    from dict_factory.languages import LANGUAGES

    full = {"s": {lang: f"sentence in {lang} here" for lang in LANGUAGES}}
    parsed = parse_monolingual_item("GREET_HELLO", full, "v1")
    assert len(parsed["sentences"]) == 35
    with pytest.raises(ValueError, match="missing langs"):
        parse_monolingual_item("GREET_HELLO", {"s": {"en": "Hello there"}}, "v1")
    with pytest.raises(ValueError):
        bad = {"s": {lang: ("x" if lang != "en" else "Hello there") for lang in LANGUAGES}}
        parse_monolingual_item("GREET_HELLO", bad, "v1")


def test_bilingual_length_ratio_rejects_non_translation() -> None:
    ok = parse_bilingual_item("X", "ja", "vi", {"st": "こんにちは、元気ですか？", "sb": "Chào bạn, bạn khỏe không?"}, "v1")
    assert ok["sent_target"].startswith("こんにちは")
    with pytest.raises(ValueError, match="length ratio"):
        parse_bilingual_item("X", "ja", "vi", {"st": "x" * 100, "sb": "Chào"}, "v1")
    with pytest.raises(ValueError, match="length ratio"):
        parse_bilingual_item("X", "ja", "vi", {"st": "Hi", "sb": "y" * 100}, "v1")


def test_load_examples_roundtrip_and_prompt_v_migration(conn_mono: sqlite3.Connection, tmp_path) -> None:
    import os

    from dict_factory.languages import LANGUAGES

    d = tmp_path / "examples_mono"
    os.makedirs(d, exist_ok=True)
    (d / "GREET_HELLO.json").write_text(
        json.dumps(
            {
                "concept_id": "GREET_HELLO",
                "prompt_v": "v1",
                "data": {"s": {lang: f"Example sentence {lang} {i}" for i, lang in enumerate(LANGUAGES)}},
            }
        )
    )
    n = load_examples(conn=conn_mono, dest_dir=d)
    assert n == 35
    cols = {row[1] for row in conn_mono.execute("PRAGMA table_info(examples)")}
    assert "prompt_v" in cols
    row = conn_mono.execute(
        "SELECT sentence, prompt_v FROM examples WHERE concept_id='GREET_HELLO' AND lang='ja'"
    ).fetchone()
    assert row[0].startswith("Example sentence ja")
    assert row[1] == "v1"
    detail = learn_concept_pair(conn_mono, "GREET_HELLO", base="vi", target="ja")
    assert detail["mono"] == row[0]


def test_load_examples_skips_unknown_concept(conn_mono: sqlite3.Connection, tmp_path, capsys) -> None:
    import os

    from dict_factory.languages import LANGUAGES

    d = tmp_path / "examples_mono"
    os.makedirs(d, exist_ok=True)
    (d / "NOPE.json").write_text(
        json.dumps(
            {
                "concept_id": "NOPE",
                "prompt_v": "v1",
                "data": {"s": {lang: f"Sentence {lang} here" for lang in LANGUAGES}},
            }
        )
    )
    assert load_examples(conn=conn_mono, dest_dir=d) == 0
    assert "not in concepts" in capsys.readouterr().out
