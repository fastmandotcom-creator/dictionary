from __future__ import annotations

import sqlite3

from dict_factory.db import init_schema
from dict_factory.session import (
    build_placement_questions,
    estimate_session_minutes,
    estimate_start_level,
    session_queue,
)


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    # 6 concepts per band so distractor lookups always succeed
    rows = [
        ("GREET_HELLO", "A1"), ("WATER", "A1"), ("EAT_RICE", "A1"),
        ("SLEEP_NIGHT", "A1"), ("BUY_APPLE", "A1"), ("WALK_DOG", "A1"),
        ("SELL_CAR", "A2"), ("FIX_BIKE", "A2"), ("COFFEE_SHOP", "A2"),
        ("MAIL_LETTER", "A2"), ("BANK_ACCOUNT", "A2"), ("RAIN_OUTFIT", "A2"),
        ("NEGOTIATE_DEAL", "B1"), ("DEBATE_POLICY", "B1"), ("APPLY_VISA", "B1"),
        ("INVEST_STOCK", "B1"), ("TAX_REFUND", "B1"), ("LEGAL_CLAUSE", "B1"),
        ("SUBSIDIIZE_FARMERS", "B2"), ("AMEND_CONSTITUTION", "B2"), ("DIPLOMATIC_NOTE", "B2"),
        ("FISCAL_AUCTION", "B2"), ("RATIFY_TREATY", "B2"), ("JUDICIAL_PANEL", "B2"),
        ("GRATUITOUS_ACT", "C1"), ("PUNITIVE_DAMAGES", "C1"), ("QUOTIENT_RULE", "C1"),
        ("HYPOTHECA_DEED", "C1"), ("MORATORIUM_DATE", "C1"), ("INCHOATE_RIGHT", "C1"),
    ]
    for i, (cid, cefr) in enumerate(rows):
        conn.execute(
            "INSERT INTO concepts(id, domain, cefr, pos, gloss_en, rank) VALUES(?,?,?,?,?,?)",
            (cid, "general", cefr, "noun", f"gloss-{cid}", i + 1),
        )
        conn.execute(
            "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) VALUES(?,?,?,?,?)",
            (cid, "ja", f"ja-{cid}", "word", "meaning"),
        )
        conn.execute(
            "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) VALUES(?,?,?,?,?)",
            (cid, "vi", f"vi-{cid}", "word", "meaning"),
        )
    conn.execute("INSERT INTO exam_framework(code,lang,name,version) VALUES('JLPT','ja','JLPT',1)")
    conn.execute(
        "INSERT INTO exam_level(framework,code,label,cefr_lo,cefr_hi,sort_no,source,prompt_v) "
        "VALUES('JLPT','N3','N3','A2','B1',1,'community-estimate','v1')"
    )
    conn.commit()
    return conn


def test_estimate_start_level_boundaries() -> None:
    # >=80% overall -> B1 (8/10 and 10/10)
    assert estimate_start_level(8, 10) == "B1"
    assert estimate_start_level(10, 10) == "B1"
    # 50-79% overall -> A2
    assert estimate_start_level(5, 10) == "A2"  # exactly 50%
    assert estimate_start_level(7, 10) == "A2"
    # <50% -> A1
    assert estimate_start_level(4, 10) == "A1"
    # no answers at all -> A1
    assert estimate_start_level(0, 0) == "A1"


def test_placement_questions_shape_and_determinism() -> None:
    conn = _db()
    q1 = build_placement_questions(conn, "vi", "ja")
    q2 = build_placement_questions(conn, "vi", "ja")
    assert q1 == q2, "same pair must produce the same quiz"
    assert len(q1) == 10
    bands = {}
    for q in q1:
        bands[q["band"]] = bands.get(q["band"], 0) + 1
    assert bands == {"easy": 4, "hard": 6}
    for q in q1:
        assert q["prompt"].startswith("ja-")
        assert len(q["options"]) == 4
        assert q["answer"] in q["options"]
        assert q["answer"].startswith("vi-")
        assert q["options"].count(q["answer"]) == 1
    conn.close()


def test_session_queue_exam_scope() -> None:
    conn = _db()
    q = session_queue(conn, "vi", "ja", exam="JLPT_N3")
    assert q["levels"] == ["A2", "B1"]
    q2 = session_queue(conn, "vi", "ja", cefr="A1")
    assert q2["levels"] == ["A1"]
    q3 = session_queue(conn, "vi", "ja")
    assert q3["levels"] == ["A1", "A2", "B1", "B2", "C1"]
    for item in q3["units"]:
        assert item["concept_ids"]
    conn.close()


def test_session_queue_unknown_exam_raises() -> None:
    conn = _db()
    try:
        session_queue(conn, "vi", "ja", exam="NOPE_X")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    conn.close()


def test_estimate_session_minutes() -> None:
    assert estimate_session_minutes(10, 0) == 3  # 200s -> 3.33 -> 3
    assert estimate_session_minutes(0, 0) == 0
    assert estimate_session_minutes(30, 30) == 20  # 60 cards * 20s = 20 min


if __name__ == "__main__":
    test_estimate_start_level_boundaries()
    test_placement_questions_shape_and_determinism()
    test_session_queue_exam_scope()
    test_session_queue_unknown_exam_raises()
    test_estimate_session_minutes()
    print("session.py unit checks passed")
