"""M0 scheduler tests: per-model backoff, deterministic drills fallback, resume.

These tests exercise the fixed rate-limit scheduler in dict_factory/offline_fill
without touching the real LLM gateway or the 12k warehouse. All module globals
(DB paths, the LLM call, tunables, and the progress store) are monkeypatched so
the suite is hermetic and fast.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

import dict_factory.offline_fill as f
from dict_factory.db import init_schema
from dict_factory.drills import drill_matrix_for_pos


@pytest.fixture(autouse=True)
def _clean_scheduler(monkeypatch, tmp_path):
    """Give every test a fresh backoff/cooldown/rotation state + isolated DBs."""
    monkeypatch.setattr(f, "PROGRESS_DB", tmp_path / "offline_fill.db")
    monkeypatch.setattr(f, "RAW_DIR", tmp_path / "raw")
    monkeypatch.setattr(f, "PATIENCE_SECONDS", 0.05)
    monkeypatch.setattr(f, "BACKOFF_BASE", 0.01)
    monkeypatch.setattr(f, "BACKOFF_FACTOR", 2.0)
    monkeypatch.setattr(f, "BACKOFF_CAP", 0.05)
    f._reset_scheduler()
    yield


def _schema_conn(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    return conn


def _row_conn(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def _seed_concept(conn: sqlite3.Connection, cid: str, pos: str, en: str, rank: int = 1) -> None:
    conn.execute(
        "INSERT INTO concepts (id, domain, cefr, pos, gloss_en, rank) VALUES (?,?,?,?,?,?)",
        (cid, "general", "A1", pos, en, rank),
    )
    conn.execute(
        "INSERT INTO expressions (concept_id, lang, text, expression_type, meaning) VALUES (?,?,?,?,?)",
        (cid, "en", en, "word", en),
    )
    conn.commit()


# --- deterministic drills fallback (M0.4) ---------------------------------


def test_fallback_pack_valid_for_all_pos() -> None:
    seen = set()
    for pos in ("verb", "phrase", "noun", "adjective", "adverb", "other"):
        concept = {"id": f"C_{pos}", "pos": pos, "gloss_en": "sample", "en": "sample"}
        rows = f.deterministic_drills_pack(concept)
        validated = f.validate_drill_pack(rows, drill_matrix_for_pos(pos), "en")
        assert len(validated) == len(drill_matrix_for_pos(pos))
        # validator enforces the meaning anchor: every sentence contains the surface
        for row in validated:
            assert row["surface"].lower() in row["sentence"].lower()
            if row["polarity"] == "question":
                assert row["sentence"].endswith("?")
            else:
                assert not row["sentence"].endswith("?")
        seen.add(pos)
    assert seen == {"verb", "phrase", "noun", "adjective", "adverb", "other"}


def test_fallback_payload_skips_unbuildable_concept() -> None:
    good = {"id": "GOOD", "pos": "noun", "gloss_en": "water", "en": "water"}
    # surface left blank -> gloss fallback still yields a valid pack
    bad = {"id": "EMPTY", "pos": "adverb", "gloss_en": "today", "en": ""}
    out = f._fallback_drills_payload([good, bad])
    assert "GOOD" in out and "EMPTY" in out
    assert len(out["GOOD"]) == 3


# --- _call backoff + rotation (M0.1 / M0.2) ---------------------------------


def _limit_error():
    return RuntimeError("Error code: 429 - usage limit reached")


def test_call_recovers_when_a_later_model_succeeds(monkeypatch) -> None:
    called: list[str] = []

    def fake(system, user, *, model, **_kw):
        called.append(model)
        if model == f.MODELS[0][0]:
            raise _limit_error()
        return json.dumps({"ok": True})

    monkeypatch.setattr(f, "call_chat_text", fake)
    got = f._call("drills", [{"id": "C1", "pos": "noun", "cefr": "A1", "gloss_en": "x", "en": "x"}])
    assert got == {"ok": True}
    # rotation reached the second model after the first hit its limit
    assert f.MODELS[0][0] in called and f.MODELS[1][0] in called


def test_call_raises_all_models_limited_after_patience(monkeypatch) -> None:
    def fake(system, user, *, model, **_kw):
        raise _limit_error()

    monkeypatch.setattr(f, "call_chat_text", fake)
    with pytest.raises(f.AllModelsLimited):
        f._call("drills", [{"id": "C1", "pos": "noun", "cefr": "A1", "gloss_en": "x", "en": "x"}])


# --- fill_shard fallback wiring (M0.4 into the worker) ---------------------


def test_fill_shard_drills_falls_back_on_all_limited(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / "wh.db"
    conn = _schema_conn(db_path)
    _seed_concept(conn, "VERB_X", "verb", "review", rank=1)
    _seed_concept(conn, "NOUN_Y", "noun", "budget", rank=2)
    conn.close()
    # fill_shard closes its handle, so hand each call a fresh connection to the
    # same file so assertions can reopen it afterwards.
    monkeypatch.setattr(f, "connect", lambda *a, **k: sqlite3.connect(str(db_path)))
    monkeypatch.setattr(f, "_call", lambda kind, concepts: (_ for _ in ()).throw(
        f.AllModelsLimited("all models limited")))

    written = f.fill_shard("drills", [
        {"id": "VERB_X", "pos": "verb", "cefr": "A1", "gloss_en": "review", "en": "review"},
        {"id": "NOUN_Y", "pos": "noun", "cefr": "A1", "gloss_en": "budget", "en": "budget"},
    ])
    # fill_shard returns the number of concepts covered (verb + noun = 2),
    # matching the LLM path; the DB check below confirms all 12 drills (9+3).
    assert written == 2
    check = sqlite3.connect(str(db_path))
    assert check.execute(
        "SELECT COUNT(*) FROM sentence_drills WHERE prompt_v='v1-offline'"
    ).fetchone()[0] == 12
    for cid in ("VERB_X", "NOUN_Y"):
        assert f._done_ids("drills") >= {cid}
    # fallback path recorded done, not failed
    assert f._failed_ids("drills") == set()


def test_fill_shard_non_drills_marks_failed_when_limited(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / "wh.db"
    conn = _schema_conn(db_path)
    conn.close()
    monkeypatch.setattr(f, "connect", lambda *a, **k: sqlite3.connect(str(db_path)))
    monkeypatch.setattr(f, "_call", lambda kind, concepts: (_ for _ in ()).throw(
        f.AllModelsLimited("all models limited")))
    written = f.fill_shard("phonetics", [
        {"id": "NOUN_Y", "pos": "noun", "cefr": "A1", "gloss_en": "budget", "en": "budget"},
    ])
    assert written == 0
    assert "NOUN_Y" in f._failed_ids("phonetics")


def test_fill_shard_no_fallback_flag_disables_drills_fallback(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / "wh.db"
    conn = _schema_conn(db_path)
    _seed_concept(conn, "NOUN_Y", "noun", "budget")
    conn.close()
    monkeypatch.setattr(f, "connect", lambda *a, **k: sqlite3.connect(str(db_path)))
    monkeypatch.setattr(f, "FALLBACK_DRILLS", False)
    monkeypatch.setattr(f, "_call", lambda kind, concepts: (_ for _ in ()).throw(
        f.AllModelsLimited("all models limited")))
    written = f.fill_shard("drills", [
        {"id": "NOUN_Y", "pos": "noun", "cefr": "A1", "gloss_en": "budget", "en": "budget"},
    ])
    assert written == 0
    assert "NOUN_Y" in f._failed_ids("drills")
    check = sqlite3.connect(str(db_path))
    assert check.execute("SELECT COUNT(*) FROM sentence_drills").fetchone()[0] == 0


# --- resume-only-failed (M0.3) --------------------------------------------


def test_plan_resume_failed_filters_to_failed_only(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(f, "PROGRESS_DB", tmp_path / "prog.db")
    f._mark("drills", "A", "failed")
    f._mark("drills", "B", "failed")
    f._mark("drills", "C", "done")
    concepts = [
        {"id": "A", "pos": "noun"}, {"id": "B", "pos": "noun"},
        {"id": "C", "pos": "noun"}, {"id": "D", "pos": "noun"},
    ]
    full = f.plan("drills", concepts)
    # normal pass: skips done(C), keeps A, B, D
    assert {c["id"] for shard in full for c in shard} == {"A", "B", "D"}
    resumed = f.plan("drills", concepts, resume_failed=True)
    # resume pass: only the failed, not-done shards
    assert {c["id"] for shard in resumed for c in shard} == {"A", "B"}


# --- M1 defect fixes: drill_key normalization + 503-unavailable limits -----


def test_parse_drills_tolerates_concept_id_prefixed_keys() -> None:
    """Providers started emitting `CONCEPT_ID!tense/polarity` keys; the
    normalizer must strip the prefix so valid packs are not dropped."""
    concept = {"id": "FOO_BAR", "pos": "noun", "gloss_en": "sample", "en": "sample"}
    specs = drill_matrix_for_pos("noun")
    rows = []
    for spec in specs:
        key = spec["drill_key"]
        sentence = ("The team uses sample in the office."
                    if spec["polarity"] == "affirmative"
                    else "The team does not use sample in the office."
                    if spec["polarity"] == "negative"
                    else "Does the team use sample in the office?")
        rows.append({
            "drill_key": f"FOO_BAR!{key}",   # the broken format
            "tense": spec["tense"],
            "polarity": spec["polarity"],
            "sentence": sentence,
            "surface": "sample",
            "base_hint": "gloss",
        })
    out = f.parse_drills({"packs": [{"id": "FOO_BAR", "sentences": rows}]}, [concept])
    assert "FOO_BAR" in out
    assert len(out["FOO_BAR"]) == len(specs)


def test_limited_classifies_503_unavailable_provider_cooldown() -> None:
    msg = ("Error code: 503 - {'error': {'message': "
           "'[antigravity/gemini-4-argon-low] Unavailable (reset after 140h 33m 43s)'}}")
    assert f._limited(Exception(msg))
    # classic rate-limit codes still classified
    assert f._limited(Exception("Error code: 429 - rate limit reached"))
    assert f._limited(Exception("Error code: 403 - usage limit"))
    # generic server errors are NOT capacity errors
    assert not f._limited(Exception("Error code: 500 - internal error"))


def test_replay_raw_recovers_prefixed_keys_and_marks_done(
    monkeypatch, tmp_path,
) -> None:
    """Raw replay must re-parse saved responses (with the legacy prefixed
    drill_key format) offline and write the recovered rows to the warehouse."""
    db_path = tmp_path / "wh.db"
    conn = _schema_conn(db_path)
    _seed_concept(conn, "A", "noun", "sample", rank=1)
    _seed_concept(conn, "B", "noun", "widget", rank=2)
    conn.close()
    monkeypatch.setattr(f, "connect", lambda *a, **k: _row_conn(db_path))
    raw = tmp_path / "raw"
    raw.mkdir()
    def spec_rows(cid: str, surface: str) -> list[dict[str, str]]:
        out = []
        for spec in drill_matrix_for_pos("noun"):
            key = spec["drill_key"]
            sentence = ("The team uses sample in the office."
                        if spec["polarity"] == "affirmative"
                        else "The team does not use sample in the office."
                        if spec["polarity"] == "negative"
                        else "Does the team use sample in the office?")
            out.append({
                "drill_key": f"{cid}!{key}",
                "tense": spec["tense"],
                "polarity": spec["polarity"],
                "sentence": sentence.replace("sample", surface),
                "surface": surface,
                "base_hint": "g",
            })
        return out
    payload = {"packs": [
        {"id": "A", "sentences": spec_rows("A", "sample")},
        {"id": "B", "sentences": spec_rows("B", "widget")},
    ]}
    (raw / "drills" / "A_2.txt").parent.mkdir(parents=True, exist_ok=True)
    with open(raw / "drills" / "A_2.txt", "w") as fh:
        fh.write(json.dumps(payload))
    monkeypatch.setattr(f, "RAW_DIR", raw)

    recovered = f.replay_raw()
    assert recovered["drills"] == 2
    check = sqlite3.connect(str(db_path))
    n_a = check.execute(
        "SELECT COUNT(*) FROM sentence_drills "
        "WHERE concept_id = 'A' AND topic = 'business'"
    ).fetchone()[0]
    n_b = check.execute(
        "SELECT COUNT(*) FROM sentence_drills "
        "WHERE concept_id = 'B' AND topic = 'business'"
    ).fetchone()[0]
    assert n_a == len(drill_matrix_for_pos("noun"))
    assert n_b == len(drill_matrix_for_pos("noun"))
