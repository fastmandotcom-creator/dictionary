from __future__ import annotations

import sqlite3

import pytest

from dict_factory.db import init_schema
from dict_factory.extra_data import load_examples_bilingual, load_phonetics, load_units
from dict_factory.learn_queries import learn_concept_pair, learn_level_units


@pytest.fixture
def conn_with_data(tmp_path) -> sqlite3.Connection:
    db = tmp_path / "t.db"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    conn.execute(
        "INSERT INTO concepts(id, domain, cefr, pos, gloss_en, rank) VALUES "
        "('GREET_HELLO','social','A1','phrase','say hello',1),"
        "('WATER','nature','A1','noun','liquid we drink',2)"
    )
    for cid, vi, en, ja in [
        ("GREET_HELLO", "xin chào", "hello", "こんにちは"),
        ("WATER", "nước", "water", "水"),
    ]:
        conn.execute(
            "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) VALUES(?,?,?,'word','g')",
            (cid, "vi", vi),
        )
        conn.execute(
            "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) VALUES(?,?,?,'word','g')",
            (cid, "en", en),
        )
        conn.execute(
            "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) VALUES(?,?,?,'word','g')",
            (cid, "ja", ja),
        )
    conn.commit()
    return conn


def test_learn_concept_pair_joins_base_and_target(conn_with_data: sqlite3.Connection) -> None:
    detail = learn_concept_pair(conn_with_data, "GREET_HELLO", base="vi", target="ja")
    assert detail is not None
    assert detail["target"]["text"] == "こんにちは"
    assert detail["base"]["text"] == "xin chào"
    # phonetics / bilingual absent when not filled
    assert detail["phonetics"] is None
    assert detail["bilingual"] is None


def test_learn_concept_pair_generic_pair(conn_with_data: sqlite3.Connection) -> None:
    detail = learn_concept_pair(conn_with_data, "WATER", base="en", target="ja")
    assert detail is not None
    assert detail["target"]["text"] == "水"
    assert detail["base"]["text"] == "water"


def test_learn_concept_pair_missing_returns_none(conn_with_data: sqlite3.Connection) -> None:
    assert learn_concept_pair(conn_with_data, "NOPE", base="vi", target="ja") is None


def test_learn_level_units_fallback_when_empty(conn_with_data: sqlite3.Connection) -> None:
    units = learn_level_units(conn_with_data, base="vi", target="ja", cefr="A1")
    # both concepts are A1 -> one synthesized unit containing both
    assert len(units) == 1
    assert units[0]["concept_ids"] == ["GREET_HELLO", "WATER"]
    assert units[0]["cefr"] == "A1"


def test_phonetics_fill_roundtrip(conn_with_data: sqlite3.Connection, tmp_path) -> None:
    import json
    import os

    d = tmp_path / "phonetics"
    os.makedirs(d, exist_ok=True)
    (d / "GREET_HELLO.json").write_text(
        json.dumps(
            {"concept_id": "GREET_HELLO", "lang": "ja", "prompt_v": "v1", "data": {"ro": "konnichiwa", "ipa": "[kɔn.nitɕi.wa]"}},
        )
    )
    n = load_phonetics(conn=conn_with_data, dest_dir=d)
    assert n == 1
    detail = learn_concept_pair(conn_with_data, "GREET_HELLO", base="vi", target="ja")
    assert detail["phonetics"]["romaji"] == "konnichiwa"


def test_examples_bilingual_fill_roundtrip(conn_with_data: sqlite3.Connection, tmp_path) -> None:
    import json
    import os

    d = tmp_path / "examples_bilingual"
    os.makedirs(d, exist_ok=True)
    (d / "GREET_HELLO.json").write_text(
        json.dumps(
            {
                "concept_id": "GREET_HELLO",
                "lang_target": "ja",
                "lang_base": "vi",
                "prompt_v": "v1",
                "data": {"st": "こんにちは、元気ですか？", "sb": "Chào bạn, bạn khỏe không?"},
            }
        )
    )
    n = load_examples_bilingual(conn=conn_with_data, dest_dir=d)
    assert n == 1
    detail = learn_concept_pair(conn_with_data, "GREET_HELLO", base="vi", target="ja")
    assert detail["bilingual"]["sent_target"].startswith("こんにちは")
    # cross pair not filled
    detail2 = learn_concept_pair(conn_with_data, "GREET_HELLO", base="en", target="ja")
    assert detail2["bilingual"] is None
