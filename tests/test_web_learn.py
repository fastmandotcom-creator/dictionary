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
    assert ("Hết lộ trình" in page.text) or ("Tiếp →" in page.text) or ("← Trước" in page.text)
    assert body["neighbors"]["next"], "first concept must chain forward, not stop at an empty unit"


def test_learn_list_has_progress_data() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/learn?base=vi&target=ja")
    assert res.status_code == 200
    assert "data-unit-progress" in res.text
    # SRS logic is pulled from the shared client module, not inlined
    assert "/srs.js" in res.text


def test_srs_js_served() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/srs.js")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/javascript")
    body = res.text
    # single source of truth: intervals + storage-key scheme both present
    assert "hard: 1" in body and "ok: 3" in body and "good: 7" in body
    assert "dict_srs_v2_" in body
    assert "dict_learn_progress_" in body


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


def test_learn_exam_wrong_language_rejected() -> None:
    """?exam= must match the target language, not just exist in the table."""
    from dict_factory.db import connect
    from dict_factory.exam_levels import resolve_exam_range

    conn = connect()
    try:
        if resolve_exam_range(conn, "JLPT_N3") is None:
            pytest.skip("exam levels not seeded in live DB")
        hsk = resolve_exam_range(conn, "HSK_HSK-4")  # HSK is zh
    finally:
        conn.close()
    if hsk is None:
        pytest.skip("HSK_HSK-4 not seeded; nothing to assert rejection on")
    client = TestClient(app, raise_server_exceptions=False)
    # HSK_HSK-4 on a vi->ja page is a cross-language exam -> 400
    assert client.get("/learn?base=vi&target=ja&exam=HSK_HSK-4").status_code == 400
    assert client.get("/review?base=vi&target=ja&exam=HSK_HSK-4").status_code == 400
    # the matching exam still works
    assert client.get("/learn?base=vi&target=ja&exam=JLPT_N3").status_code == 200
    assert client.get("/review?base=vi&target=ja&exam=JLPT_N3").status_code == 200
    # and HSK_HSK-4 is accepted on its own language page
    assert client.get("/learn?base=vi&target=zh&exam=HSK_HSK-4").status_code == 200


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


def _hrefs_with(page_text: str, prefix: str) -> list:
    import re
    return re.findall(r'href="' + re.escape(prefix) + r'[^"]*"', page_text)


def test_card_navigation_preserves_cefr_filter() -> None:
    """From a cefr-filtered list, the card's back/next links keep the filter."""
    client = TestClient(app, raise_server_exceptions=False)
    page = client.get("/learn/GREET_HELLO?base=vi&target=ja&cefr=A1")
    assert page.status_code == 200
    # every link that returns to the list or the review page carries the
    # cefr context (HTML entities may be & or &amp; depending on escaping).
    for prefix in ("/learn?base=vi", "/review?base=vi"):
        links = _hrefs_with(page.text, prefix)
        assert links, f"expected {prefix} links on the card page"
        assert all("cefr=A1" in link for link in links), "filter must survive navigation"
    # JS auto-advance reassembles the same query string from the cefr const
    assert 'const CEFR = "A1"' in page.text
    assert 'const EXAM = ""' in page.text


def test_card_navigation_preserves_exam_filter() -> None:
    from dict_factory.db import connect
    from dict_factory.exam_levels import resolve_exam_range

    conn = connect()
    try:
        if resolve_exam_range(conn, "JLPT_N3") is None:
            pytest.skip("exam levels not seeded in live DB")
    finally:
        conn.close()
    client = TestClient(app, raise_server_exceptions=False)
    page = client.get("/learn/GREET_HELLO?base=vi&target=ja&exam=JLPT_N3")
    assert page.status_code == 200
    # exam wins over cefr and is carried on all back-navigation links.
    assert 'const EXAM = "JLPT_N3"' in page.text
    for prefix in ("/learn?base=vi", "/review?base=vi"):
        links = _hrefs_with(page.text, prefix)
        assert all("exam=JLPT_N3" in link for link in links), "exam filter must survive"
    # a cross-language exam deep-link is rejected on the card page too
    assert client.get("/learn/GREET_HELLO?base=vi&target=ja&exam=HSK_HSK-4").status_code == 400


def test_learn_list_carries_filter_into_unit_links() -> None:
    import re
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/learn?base=vi&target=ja&cefr=A1")
    assert res.status_code == 200
    # unit card links point at /learn/<CONCEPT_ID>?... and must carry the filter
    unit_links = re.findall(r'href="/learn/[A-Z0-9_]+\?[^"]*"', res.text)
    assert unit_links, "expected unit card links on the filtered list page"
    assert all("cefr=A1" in link for link in unit_links), "unit links should carry the cefr filter"


def test_onboarding_preselects_pair_from_query() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/onboarding?base=en&target=es")
    assert res.status_code == 200
    # base/target are preselected via the query string, not hardcoded vi/ja
    import re
    base_opts = re.findall(r'<option value="([a-z]{2})" selected>', res.text)
    assert "en" in base_opts and "es" in base_opts
    # default still works
    res2 = client.get("/onboarding")
    assert res2.status_code == 200


def test_review_without_cefr_covers_all_levels() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/review?base=vi&target=ja")
    assert res.status_code == 200
    assert "Tất cả mức" in res.text


def test_no_dev_copy_in_rendered_pages() -> None:
    """Users must never see developer tooling copy (dict_factory CLI hints)."""
    client = TestClient(app, raise_server_exceptions=False)
    for url in (
        "/learn?base=vi&target=ja",
        "/learn/GREET_HELLO?base=vi&target=ja",
        "/review?base=vi&target=ja",
        "/onboarding",
        "/session?base=vi&target=ja",
        "/placement?base=vi&target=ja",
    ):
        res = client.get(url)
        assert res.status_code == 200
        assert "dict_factory" not in res.text, f"dev copy leaked on {url}"


def test_session_route_and_api() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    page = client.get("/session?base=vi&target=ja")
    assert page.status_code == 200
    assert "Hôm nay của bạn" in page.text  # overview panel with N new + M due
    assert "/srs.js" in page.text
    # new size is bounded (5..30)
    assert client.get("/session?base=vi&target=ja&new=999").status_code == 422
    api = client.get("/api/session?base=vi&target=ja&cefr=A1")
    assert api.status_code == 200
    body = api.json()
    assert body["levels"] == ["A1"]
    assert body["new_count"] == 10
    assert body["units"], "session must carry units with concept ids"


def test_review_shows_session_estimate() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/review?base=vi&target=ja")
    assert res.status_code == 200
    assert "session-est" in res.text  # "Buổi ôn hôm nay: M thẻ · ~p phút"


def test_placement_quiz_flow() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    # questions: 10 items, 4 easy + 6 hard, each with 4 base-language options
    q = client.get("/api/placement?base=vi&target=ja")
    assert q.status_code == 200
    questions = q.json()["questions"]
    assert len(questions) == 10
    bands = [x for x in questions if x["band"] == "hard"]
    assert len(bands) == 6
    for item in questions:
        assert len(item["options"]) == 4
        assert item["answer"] in item["options"]
    # submitting all-correct answers must yield B1 (>=80% hard)
    correct = [
        {"conceptId": item["conceptId"], "choice": item["answer"]} for item in questions
    ]
    scored = client.post("/api/placement", json={"base": "vi", "target": "ja", "answers": correct})
    assert scored.status_code == 200
    assert scored.json()["cefr"] == "B1"
    # submitting nothing must yield A1
    empty = client.post("/api/placement", json={"base": "vi", "target": "ja", "answers": []})
    assert empty.json()["cefr"] == "A1"
