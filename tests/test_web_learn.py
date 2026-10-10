from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

import pytest

from dict_factory.db import init_schema
from dict_factory.web_server import app


def _db_path() -> str:
    return str(Path(__file__).resolve().parents[1] / "out" / "warehouse.db")


def test_learn_routes_generic_pair() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    # onboarding
    res = client.get("/onboarding")
    assert res.status_code == 200
    assert "Tôi muốn học" in res.text or "target" in res.text
    # learn list vi->ja
    res = client.get("/learn?base=vi&target=ja&cefr=A1")
    assert res.status_code == 200
    # a generic different pair still renders
    res = client.get("/learn?base=en&target=es&cefr=A1")
    assert res.status_code == 200
    # unknown concept 404
    res = client.get("/learn/THIS_DOES_NOT_EXIST_XYZ?base=vi&target=ja")
    assert res.status_code == 404
    # bad pair 400
    res = client.get("/learn?base=xx&target=ja")
    assert res.status_code == 400
    # api learn
    res = client.get("/api/learn/GREET_HELLO?base=vi&target=ja")
    assert res.status_code == 200
    body = res.json()
    assert body["concept"]["id"] == "GREET_HELLO"
    assert body["target"]["text"] == "こんにちは"
    assert body["base"]["text"] == "xin chào"


def test_review_route() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/review?base=vi&target=ja&cefr=A1")
    assert res.status_code == 200
    assert "flashcard" in res.text.lower() or "card" in res.text.lower()


def test_review_exam_context() -> None:
    from dict_factory.db import connect
    from dict_factory.exam_levels import resolve_exam_range

    conn = connect()
    try:
        if resolve_exam_range(conn, "JLPT_N3") is None:
            pytest.skip("exam levels not seeded in live DB")
    finally:
        conn.close()
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/review?base=vi&target=ja&exam=JLPT_N3")
    assert res.status_code == 200
    assert "JLPT_N3" in res.text
    assert client.get("/review?base=vi&target=ja&exam=NOPE_X1").status_code == 400


def test_learn_card_neighbors_and_api() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/api/learn/GREET_HELLO?base=vi&target=ja")
    assert res.status_code == 200
    body = res.json()
    assert "neighbors" in body
    assert set(body["neighbors"].keys()) == {"prev", "next", "unit_id"}
    # the learn card page renders prev/next blocks
    page = client.get("/learn/GREET_HELLO?base=vi&target=ja")
    assert page.status_code == 200
    assert ("Cuối unit" in page.text) or ("Tiếp →" in page.text) or ("← Trước" in page.text)


def test_learn_list_has_progress_data() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/learn?base=vi&target=ja")
    assert res.status_code == 200
    assert "data-unit-progress" in res.text
    assert "dict_srs_v2" in res.text


def test_invalid_params_rejected_with_400() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/learn?base=vi&target=ja&cefr=Z9").status_code == 400
    assert client.get("/?lang=xx").status_code == 400
    assert client.get("/?cefr=Z9").status_code == 400
    assert client.get("/?pos=nonsense").status_code == 400
    assert client.get("/review?base=vi&target=ja&cefr=Z9").status_code == 400
    assert client.get("/api/learn/GREET_HELLO?base=vi&target=xx").status_code == 400
    # valid values still pass
    assert client.get("/?lang=vi&cefr=A1&pos=noun").status_code == 200


def test_learn_exam_filter() -> None:
    from dict_factory.db import connect
    from dict_factory.exam_levels import resolve_exam_range

    conn = connect()
    try:
        if resolve_exam_range(conn, "JLPT_N3") is None:
            pytest.skip("exam levels not seeded in live DB")
    finally:
        conn.close()
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/learn?base=vi&target=ja&exam=JLPT_N3")
    assert res.status_code == 200
    assert "JLPT" in res.text
    assert client.get("/learn?base=vi&target=ja&exam=NOPE_X1").status_code == 400
    assert client.get("/learn?base=vi&target=ja&exam=junk").status_code == 400


def test_learn_exam_dropdown_scoped_to_target_lang() -> None:
    """vi->ja must show only JLPT (ja), not DELE/HSK/TOEIC from other languages."""
    from dict_factory.db import connect
    from dict_factory.exam_levels import exam_frameworks_for_lang

    conn = connect()
    try:
        if "JLPT" not in exam_frameworks_for_lang(conn, "ja"):
            pytest.skip("JLPT not seeded in live DB")
    finally:
        conn.close()
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/learn?base=vi&target=ja")
    assert res.status_code == 200
    # The exam dropdown is scoped to the target language. Check option VALUES
    # (not bare substrings — concept ids like DELETERIOUS_EFFECT contain "DELE").
    assert 'value="JLPT_' in res.text, "ja exam framework (JLPT) should be offered"
    for other in ("DELE", "DELF", "HSK", "TOEIC", "GOETHE", "TOPIK", "CELPE", "CELI"):
        assert f'value="{other}_' not in res.text, f"exam framework {other} leaked into vi->ja dropdown"
    # a target language with no exam framework hides the dropdown entirely
    noexam = client.get("/learn?base=vi&target=th")
    assert noexam.status_code == 200
    assert "Kỳ thi" not in noexam.text
