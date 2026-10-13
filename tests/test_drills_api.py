from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import dict_factory.drills as drills
import dict_factory.web_server as web
from dict_factory.db import init_schema


class ApiFakeProvider:
    """No-arg provider the route can construct; deterministic valid packs."""

    name = "fake"
    calls = 0

    def __init__(self):
        pass

    def generate(self, *, concept, pos, topic, target_lang, base_lang, specs):
        ApiFakeProvider.calls += 1
        s = concept["en_surface"].lower()
        rows = []
        for spec in specs:
            tense, pol = spec["tense"], spec["polarity"]
            if pos in ("verb", "phrase"):
                w = s + "ed" if tense == "past_simple" else s
                sent = {"affirmative": f"I {w} today.",
                        "negative": f"I do not {w} today.",
                        "question": f"Do you {w} today?"}[pol]
            else:
                w = s
                sent = {"affirmative": f"This is {w}.",
                        "negative": f"This is not {w}.",
                        "question": f"Is this {w}?"}[pol]
            rows.append({"drill_key": spec["drill_key"], "tense": tense,
                         "polarity": pol, "sentence": sent, "surface": w,
                         "base_hint": ""})
        return rows


@pytest.fixture()
def api_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db = tmp_path / "w.db"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    conn.execute("INSERT INTO concepts(id,domain,cefr,pos,gloss_en,rank) "
                 "VALUES('GREET_HELLO','social','A1','verb','greet someone',1)")
    conn.execute("INSERT INTO expressions(concept_id,lang,text,expression_type,meaning) "
                 "VALUES('GREET_HELLO','en','greet','word','say hello')")
    conn.commit()

    def _fake_get_db(*a, **k):
        c = sqlite3.connect(str(db))
        c.row_factory = sqlite3.Row
        return c

    monkeypatch.setattr(web, "get_db", _fake_get_db)
    monkeypatch.setattr(drills, "LLMDrillProvider", ApiFakeProvider)
    ApiFakeProvider.calls = 0
    yield db
    conn.close()


def test_get_drills_cache_first(api_env) -> None:
    client = TestClient(web.app, raise_server_exceptions=False)
    r1 = client.get("/api/drills", params={"concept_id": "GREET_HELLO", "topic": "general"})
    assert r1.status_code == 200
    body = r1.json()
    assert body["source"] == "fake"
    assert body["meta"]["count"] == 9
    assert ApiFakeProvider.calls == 1
    # second call: served from the warehouse cache, no new LLM call
    r2 = client.get("/api/drills", params={"concept_id": "GREET_HELLO", "topic": "general"})
    assert r2.status_code == 200
    assert r2.json()["source"] == "cache"
    assert ApiFakeProvider.calls == 1
    # different topic => separate cache entry => one more call
    r3 = client.get("/api/drills", params={"concept_id": "GREET_HELLO", "topic": "business"})
    assert r3.status_code == 200
    assert ApiFakeProvider.calls == 2


def test_get_drills_rejects_bad_topic_and_concept(api_env) -> None:
    client = TestClient(web.app, raise_server_exceptions=False)
    assert client.get("/api/drills", params={"concept_id": "GREET_HELLO", "topic": "kitchen"}).status_code == 400
    assert client.get("/api/drills", params={"concept_id": "NOPE", "topic": "general"}).status_code == 404


def test_drill_topics_lists_presets(api_env) -> None:
    client = TestClient(web.app, raise_server_exceptions=False)
    body = client.get("/api/drills/topics").json()
    assert set(body["topics"]) == {"general", "business", "travel", "daily"}


def test_force_generate_refills_pack(api_env) -> None:
    client = TestClient(web.app, raise_server_exceptions=False)
    # warm the cache
    client.get("/api/drills", params={"concept_id": "GREET_HELLO", "topic": "travel"})
    assert ApiFakeProvider.calls == 1
    r = client.post("/api/drills/generate",
                    json={"concept_id": "GREET_HELLO", "topic": "travel"})
    assert r.status_code == 200
    assert r.json()["meta"]["forced"] is True
    assert ApiFakeProvider.calls == 2
    # and it is now served from cache again
    assert client.get("/api/drills",
                      params={"concept_id": "GREET_HELLO", "topic": "travel"}).json()["source"] == "cache"
