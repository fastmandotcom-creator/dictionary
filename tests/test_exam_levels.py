from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from dict_factory.db import init_schema
from dict_factory.exam_levels import (
    EXAM_FRAMEWORKS,
    EXAM_SOURCES,
    cefr_range_levels,
    exam_frameworks_for_lang,
    list_exam_levels,
    parse_exam_ref,
    resolve_exam_range,
)
from dict_factory.extra_data import load_exam_levels, parse_exam_level, validate_exam_table
from dict_factory.prompts import prompt_messages, validate_payload


def _rows():
    return [
        {"framework": "JLPT", "code": "N5", "label": "N5", "cefr_lo": "A1", "cefr_hi": "A1", "sort_no": 1, "source": "community-estimate"},
        {"framework": "JLPT", "code": "N4", "label": "N4", "cefr_lo": "A2", "cefr_hi": "A2", "sort_no": 2, "source": "community-estimate"},
        {"framework": "JLPT", "code": "N3", "label": "N3", "cefr_lo": "A2", "cefr_hi": "B1", "sort_no": 3, "source": "community-estimate"},
        {"framework": "JLPT", "code": "N2", "label": "N2", "cefr_lo": "B1", "cefr_hi": "B2", "sort_no": 4, "source": "community-estimate"},
        {"framework": "JLPT", "code": "N1", "label": "N1", "cefr_lo": "B2", "cefr_hi": "C1", "sort_no": 5, "source": "community-estimate"},
    ]


def test_exam_prompt_renders_and_validates() -> None:
    spec = EXAM_FRAMEWORKS["JLPT"]
    messages = prompt_messages("exam_levels", variables={
        "framework_code": "JLPT",
        "framework_lang": spec["lang"],
        "framework_name": spec["name"],
        "source_tag": spec["source"],
        "level_codes": ", ".join(spec["levels"]),
        "mapping_table": spec["mapping_table"],
        "count": len(spec["levels"]),
    })
    assert len(messages) == 2
    assert "N5" in messages[1]["content"]
    validate_payload("exam_levels", _rows())


def test_parse_exam_level_gates() -> None:
    codes = EXAM_FRAMEWORKS["JLPT"]["levels"]
    ok = parse_exam_level("JLPT", codes, EXAM_SOURCES, dict(_rows()[0]), "v1")
    assert ok["code"] == "N5" and ok["prompt_v"] == "v1"
    bad_code = dict(_rows()[0], code="N6")
    with pytest.raises(ValueError, match="closed enum"):
        parse_exam_level("JLPT", codes, EXAM_SOURCES, bad_code, "v1")
    bad_range = dict(_rows()[2], cefr_lo="B1", cefr_hi="A2")
    with pytest.raises(ValueError, match="inverted range"):
        parse_exam_level("JLPT", codes, EXAM_SOURCES, bad_range, "v1")
    bad_source = dict(_rows()[0], source="trust-me-bro")
    with pytest.raises(ValueError, match="not allowlisted"):
        parse_exam_level("JLPT", codes, EXAM_SOURCES, bad_source, "v1")
    bad_fw = dict(_rows()[0], framework="JLPTX")
    with pytest.raises(ValueError, match="framework mismatch"):
        parse_exam_level("JLPT", codes, EXAM_SOURCES, bad_fw, "v1")


def test_validate_exam_table_gates() -> None:
    assert [r["code"] for r in validate_exam_table("JLPT", _rows())] == ["N5", "N4", "N3", "N2", "N1"]
    gap_sort = [dict(r) for r in _rows()]
    gap_sort[2]["sort_no"] = 2
    with pytest.raises(ValueError, match="no gaps"):
        validate_exam_table("JLPT", gap_sort)
    hole = [dict(r, sort_no=i + 1) for i, r in enumerate([r for r in _rows() if r["code"] not in ("N4", "N3", "N2")])]
    with pytest.raises(ValueError, match="holes inside"):
        validate_exam_table("JLPT", hole)
    partial = [dict(r, sort_no=i + 1) for i, r in enumerate([r for r in _rows() if r["code"] in ("N3", "N2", "N1")])]
    assert [r["code"] for r in validate_exam_table("JLPT", partial)] == ["N3", "N2", "N1"]
    flipped = [dict(_rows()[0], cefr_lo="C1", cefr_hi="C1")]
    with pytest.raises(ValueError, match="non-monotonic|gaps"):
        validate_exam_table("JLPT", flipped + _rows()[1:])
    with pytest.raises(ValueError, match="empty"):
        validate_exam_table("JLPT", [])


def test_load_exam_levels_roundtrip(tmp_path: Path) -> None:
    db = tmp_path / "t.db"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    stage = tmp_path / "exam_levels"
    stage.mkdir()
    (stage / "JLPT.json").write_text(json.dumps({
        "framework": "JLPT", "lang": "ja", "name": "JLPT", "prompt_v": "v1", "data": _rows(),
    }))
    assert load_exam_levels(conn, dest_dir=stage) == 5
    assert resolve_exam_range(conn, "JLPT_N3") == ("A2", "B1")
    assert resolve_exam_range(conn, "JLPT_N9") is None
    assert resolve_exam_range(conn, "nope") is None
    assert parse_exam_ref("JLPT_N3") == ("JLPT", "N3")
    assert parse_exam_ref("junk") is None
    levels = list_exam_levels(conn)
    assert [l["code"] for l in levels if l["framework"] == "JLPT"] == ["N5", "N4", "N3", "N2", "N1"]
    # reload replaces, no dupes
    assert load_exam_levels(conn, dest_dir=stage) == 5
    assert conn.execute("SELECT COUNT(*) FROM exam_level WHERE framework='JLPT'").fetchone()[0] == 5
    conn.close()


def test_cefr_range_levels() -> None:
    assert cefr_range_levels("A2", "B1") == ["A2", "B1"]
    assert cefr_range_levels("A1", "A1") == ["A1"]
    assert cefr_range_levels("A1", "C1") == ["A1", "A2", "B1", "B2", "C1"]
    assert cefr_range_levels("Z9", "B1") == []


def test_seed_tables_cover_all_frameworks() -> None:
    assert len(EXAM_FRAMEWORKS) == 10
    for code, spec in EXAM_FRAMEWORKS.items():
        assert spec["source"] in EXAM_SOURCES, code
        assert len(spec["levels"]) >= 4, code
        assert spec["mapping_table"].strip(), code


def test_list_exam_levels_lang_filter_and_display(tmp_path: Path) -> None:
    db = tmp_path / "t.db"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    # two frameworks for different target languages; labels mix "already prefixed" and "bare"
    conn.execute("INSERT INTO exam_framework(code,lang,name,version) VALUES('JLPT','ja','JLPT',1)")
    conn.execute("INSERT INTO exam_framework(code,lang,name,version) VALUES('DELE','es','DELE',1)")
    conn.execute(
        "INSERT INTO exam_level(framework,code,label,cefr_lo,cefr_hi,sort_no,source,prompt_v) VALUES"
        "('JLPT','N5','N5','A1','A1',1,'community-estimate','v1')"
    )
    conn.execute(
        "INSERT INTO exam_level(framework,code,label,cefr_lo,cefr_hi,sort_no,source,prompt_v) VALUES"
        "('DELE','A1','DELE A1','A1','A1',1,'community-estimate','v1')"
    )
    conn.commit()
    # filter by target language
    ja = list_exam_levels(conn, "ja")
    assert [l["framework"] for l in ja] == ["JLPT"]
    assert [l["code"] for l in ja] == ["N5"]
    es = list_exam_levels(conn, "es")
    assert [l["code"] for l in es] == ["A1"]
    # display dedups: bare "N5" gets prefix, "DELE A1" (already prefixed) stays as-is
    assert ja[0]["display"] == "JLPT N5"
    assert es[0]["display"] == "DELE A1"
    # no lang filter -> everything
    assert sorted(l["framework"] for l in list_exam_levels(conn)) == ["DELE", "JLPT"]
    # exam_frameworks_for_lang
    assert exam_frameworks_for_lang(conn, "ja") == ["JLPT"]
    assert exam_frameworks_for_lang(conn, "es") == ["DELE"]
    assert exam_frameworks_for_lang(conn, "vi") == []
    conn.close()


def test_missing_tables_tolerated() -> None:
    conn = sqlite3.connect(":memory:")
    assert list_exam_levels(conn) == []
    assert resolve_exam_range(conn, "JLPT_N3") is None
    conn.close()
