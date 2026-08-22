from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from dict_factory.db import init_schema
from dict_factory.web_queries import get_concept_detail, get_stats, search_concepts
from dict_factory.web_server import app


@pytest.fixture
def mock_db(tmp_path: Path) -> sqlite3.Connection:
    db_path = tmp_path / "test_warehouse.db"
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    init_schema(conn)

    conn.execute(
        "INSERT INTO concepts(id, domain, cefr, pos, gloss_en, rank) VALUES('DRINK_WATER', 'nature', 'A1', 'phrase', 'to drink water', 1)"
    )
    conn.execute(
        "INSERT INTO concepts(id, domain, cefr, pos, gloss_en, rank) VALUES('EAT_BREAD', 'food', 'A1', 'verb', 'to eat bread', 2)"
    )

    for cid, (en, vi) in [("DRINK_WATER", ("drink water", "uống nước")), ("EAT_BREAD", ("eat bread", "ăn bánh mì"))]:
        conn.execute(
            "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) VALUES(?, 'en', ?, 'phrase', 'gloss-en')",
            (cid, en),
        )
        conn.execute(
            "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) VALUES(?, 'vi', ?, 'verb_expression', 'gloss-vi')",
            (cid, vi),
        )
        conn.execute(
            "INSERT INTO examples(concept_id, lang, sentence) VALUES(?, 'en', 'Example en sentence')",
            (cid,),
        )
        conn.execute(
            "INSERT INTO examples(concept_id, lang, sentence) VALUES(?, 'vi', 'Câu ví dụ tiếng Việt')",
            (cid,),
        )
    conn.commit()
    return conn


def test_search_concepts_empty_query(mock_db: sqlite3.Connection) -> None:
    items, total = search_concepts(mock_db)
    assert total == 2
    assert len(items) == 2
    assert items[0]["id"] == "DRINK_WATER"


def test_search_concepts_by_vietnamese_word(mock_db: sqlite3.Connection) -> None:
    items, total = search_concepts(mock_db, q="bánh mì")
    assert total == 1
    assert items[0]["id"] == "EAT_BREAD"
    assert items[0]["vi_text"] == "ăn bánh mì"


def test_get_concept_detail(mock_db: sqlite3.Connection) -> None:
    detail = get_concept_detail(mock_db, "DRINK_WATER")
    assert detail is not None
    assert detail["concept"]["id"] == "DRINK_WATER"
    assert len(detail["expressions"]) == 2
    assert detail["expressions"][0]["concept_id"] == "DRINK_WATER"


def test_web_routes_live() -> None:
    client = TestClient(app)
    res = client.get("/")
    assert res.status_code == 200
    assert "Dict Explorer" in res.text
    assert "Read-Only" in res.text

    res_detail = client.get("/concept/GREET_HELLO")
    assert res_detail.status_code == 200
    assert "GREET_HELLO" in res_detail.text
    assert "All 35 Language Expressions" in res_detail.text
    assert "meaning" in res_detail.text

    res_api = client.get("/api/concept/GREET_HELLO")
    assert res_api.status_code == 200
    data = res_api.json()
    assert data["concept"]["id"] == "GREET_HELLO"
    assert len(data["expressions"]) == 35
