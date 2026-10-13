from __future__ import annotations

import sqlite3

import pytest

from dict_factory.languages import LANGUAGES
import dict_factory.tts as tts


class FakeVendor:
    def __init__(self, name: str, ok: bool = True, audio: bytes = b"MP3DATA"):
        self.name = name
        self.ok = ok
        self.audio = audio
        self.calls = 0

    def synthesize(self, text: str, voice: str, lang: str):
        self.calls += 1
        if not self.ok:
            raise RuntimeError(f"{self.name} is down")
        return self.audio, "audio/mpeg"


def test_voice_catalog_covers_all_35_languages() -> None:
    assert set(tts.VOICE_CATALOG) == set(LANGUAGES)
    for code in sorted(LANGUAGES):
        voice = tts.resolve_voice(code)
        family = voice.split("-")[0]
        assert family in tts.allowed_families(code), f"{code} voice {voice} wrong family"
        if code != "en":
            assert family != "en", f"{code} must never resolve to an English voice"


def test_aliases_no_nb_he_iw() -> None:
    assert tts.VOICE_ALIAS["no"] == "nb"
    assert tts.resolve_voice("no").split("-")[0] == "nb"
    assert "he" in tts.allowed_families("he")
    assert tts.resolve_voice("he")  # resolves, family he (modern edge naming)


def test_unknown_language_rejected() -> None:
    with pytest.raises(tts.TtsVoiceError):
        tts.resolve_voice("xx")
    with pytest.raises(tts.TtsVoiceError):
        tts.resolve_voice("")


def _tmp_cache() -> sqlite3.Connection:
    return tts._open_cache(":memory:")


def test_cache_first_single_vendor_call(tmp_path) -> None:
    def file_cache() -> sqlite3.Connection:
        return tts._open_cache(str(tmp_path / "tts.db"))

    cache = file_cache()
    vendor = FakeVendor("fake")
    health = tts.VendorHealth()
    r1 = tts.synthesize_cached("vi", "xin chào", vendors=[vendor], health=health, cache=cache)
    assert r1.source == "fake"
    assert vendor.calls == 1
    r2 = tts.synthesize_cached("vi", "xin chào", vendors=[vendor], health=health, cache=cache)
    assert r2.source == "cache"
    assert vendor.calls == 1
    assert r2.audio == r1.audio
    # different text is a different key -> one more call
    r3 = tts.synthesize_cached("vi", "tạm biệt", vendors=[vendor], health=health, cache=cache)
    assert r3.source == "fake"
    assert vendor.calls == 2
    # a second process (fresh in-memory LRU, same on-disk cache) still hits the disk
    cache2 = file_cache()
    r4 = tts.synthesize_cached("vi", "tạm biệt", vendors=[vendor], health=health, cache=cache2)
    assert r4.source == "cache"
    assert vendor.calls == 2
    key = tts._cache_key("vi", tts.VOICE_CATALOG["vi"], "tạm biệt")
    assert cache2.execute("SELECT hits FROM tts_cache WHERE key = ?", (key,)).fetchone() is not None
    cache.close()
    cache2.close()


def test_vendor_failures_cool_down_and_error_clearly() -> None:
    bad = FakeVendor("bad", ok=False)
    health = tts.VendorHealth()
    with pytest.raises(tts.TtsVendorError) as exc:
        tts.synthesize_cached("fr", "bonjour", vendors=[bad], health=health, cache=_tmp_cache())
    assert "bad" in str(exc.value)
    # after the failure the vendor cools down: the next call fails fast
    with pytest.raises(tts.TtsVendorError) as exc2:
        tts.synthesize_cached("fr", "bonjour 2", vendors=[bad], health=health, cache=_tmp_cache())
    assert "cooling down" in str(exc2.value)
    # ladder failover: first vendor down, second works
    health2 = tts.VendorHealth()
    ladder = [FakeVendor("broken", ok=False), FakeVendor("good")]
    r = tts.synthesize_cached("de", "hallo", vendors=ladder, health=health2, cache=_tmp_cache())
    assert r.source == "good"


def test_text_length_guard() -> None:
    with pytest.raises(tts.TtsError):
        tts.synthesize_cached("en", "x" * (tts.MAX_TEXT_LEN + 1), vendors=[FakeVendor("f")], cache=_tmp_cache())
    with pytest.raises(tts.TtsError):
        tts.synthesize_cached("en", "   ", vendors=[FakeVendor("f")], cache=_tmp_cache())


def test_voices_and_tts_routes(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    from fastapi.testclient import TestClient

    import dict_factory.web_server as web

    fake = FakeVendor("fake")
    monkeypatch.setattr(tts, "DEFAULT_LADDER", [fake])
    monkeypatch.setattr(tts, "DEFAULT_HEALTH", tts.VendorHealth())
    monkeypatch.setattr(tts, "_MEM_CACHE", tts._Lru())  # hermetic per-test LRU
    monkeypatch.setattr(tts, "TTS_CACHE_DB", tmp_path / "tts_cache.db")  # no real cache
    client = TestClient(web.app, raise_server_exceptions=False)

    v = client.get("/api/tts/voices", params={"lang": "vi"})
    assert v.status_code == 200
    assert v.json()["voice"] == "vi-VN-HoaiMyNeural"

    a = client.get("/api/tts", params={"lang": "vi", "text": "xin chào"})
    assert a.status_code == 200
    assert a.headers["content-type"] == "audio/mpeg"
    assert a.headers["x-tts-source"] == "fake"

    # second request: served from cache, no extra vendor call
    assert fake.calls == 1
    a2 = client.get("/api/tts", params={"lang": "vi", "text": "xin chào"})
    assert a2.status_code == 200
    assert a2.headers["x-tts-source"] == "cache"
    assert fake.calls == 1

    # unknown language: 400 (client must use its browser floor, never an EN voice)
    assert client.get("/api/tts", params={"lang": "xx", "text": "hi"}).status_code == 400
    assert client.get("/api/tts/voices", params={"lang": "xx"}).status_code == 400

    # all vendors down: clean 503, not a generic 500
    monkeypatch.setattr(tts, "DEFAULT_LADDER", [FakeVendor("dead", ok=False)])
    monkeypatch.setattr(tts, "DEFAULT_HEALTH", tts.VendorHealth())
    res = client.get("/api/tts", params={"lang": "en", "text": "hello"})
    assert res.status_code == 503
    assert "unavailable" in res.json()["detail"].lower()
