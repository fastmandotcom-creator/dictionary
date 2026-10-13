from __future__ import annotations

from fastapi.testclient import TestClient

from dict_factory.web_server import app


def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def test_listen_paginates_the_full_path() -> None:
    res = client().get("/listen?base=vi&target=en&topic=general&offset=60&limit=60")
    assert res.status_code == 200
    assert "61-120/" in res.text
    assert "cefr-select" in res.text


def test_neighbors_cross_the_empty_unit_table() -> None:
    from dict_factory.db import connect
    from dict_factory.learn_queries import learn_neighbors

    conn = connect()
    try:
        first = learn_neighbors(conn, "GREET_HELLO", "en")
        assert first["prev"] is None
        assert first["next"]
        a1_tail = learn_neighbors(conn, "BLOW_OUT_CANDLE", "en", levels=["A1"])
        assert a1_tail["next"] is None
        crossed = learn_neighbors(conn, "BLOW_OUT_CANDLE", "en")
        assert crossed["next"] == "FAMILY_HOME"
    finally:
        conn.close()


def test_listen_page_renders() -> None:
    res = client().get("/listen?base=vi&target=en&topic=general")
    assert res.status_code == 200
    body = res.text
    assert "DrillUI" in body
    assert "concept-list" in body
    assert "topic-select" in body
    assert "EAT_FOOD" in body or "CONCEPTS = []" in body


def test_listen_topic_presets_guarded() -> None:
    c = client()
    assert c.get("/listen?base=vi&target=en&topic=kitchen").status_code == 400
    assert c.get("/listen?base=vi&target=en&topic=business").status_code == 200


def test_listen_cross_language_exam_rejected() -> None:
    # HSK is a zh exam: linking it to target=en must 400 (same rule as /learn)
    assert client().get("/listen?base=vi&target=en&exam=HSK").status_code == 400


def test_listen_pair_guarded() -> None:
    assert client().get("/listen?base=xx&target=en").status_code == 400


def test_drills_js_served() -> None:
    res = client().get("/drills.js")
    assert res.status_code == 200
    assert "DrillUI" in res.text
    assert "demoPack" in res.text


def test_session_page_has_advanced_segment() -> None:
    res = client().get("/session?base=vi&target=en")
    assert res.status_code == 200
    # the segment is client-rendered; the template must carry the guard so it
    # only appears for an English target
    assert "Nâng cao (tuỳ chọn)" in res.text
    assert "drills-toggle" in res.text
    assert "TARGET === 'en'" in res.text


def test_asr_js_served() -> None:
    res = client().get("/asr.js")
    assert res.status_code == 200
    assert "global.Asr" in res.text and "isSupported" in res.text


def test_settings_page_renders() -> None:
    res = client().get("/settings")
    assert res.status_code == 200
    body = res.text
    assert "Cài đặt — giọng đọc &amp; mic" in body
    assert "tts-voice" in body and "preview-btn" in body and "mic-enabled" in body
    # 35 language codes are passed to the template
    assert '"vi"' in body and '"sw"' in body


def test_learn_header_links_to_settings() -> None:
    assert 'Cài đặt' in client().get("/learn?base=vi&target=en").text


def test_learn_page_links_to_listen() -> None:
    res = client().get("/learn?base=vi&target=en")
    assert res.status_code == 200
    assert '/listen?base=vi&target=en' in res.text
