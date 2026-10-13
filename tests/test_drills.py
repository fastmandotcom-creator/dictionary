from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from dict_factory.db import init_schema
from dict_factory.drills import (
    DrillError,
    drill_matrix_for_pos,
    get_drill_pack,
)
from dict_factory.prompts import SchemaViolation, validate_payload


class FakeProvider:
    """Deterministic provider: counts calls so cache behavior is assertable."""

    name = "fake"

    def __init__(self, corrupt: bool = False):
        self.calls = 0
        self.corrupt = corrupt

    def generate(self, *, concept, pos, topic, target_lang, base_lang, specs):
        self.calls += 1
        s = concept["en_surface"].lower()
        rows = []
        for spec in specs:
            tense, pol = spec["tense"], spec["polarity"]
            if pos in ("verb", "phrase"):
                w = s + "ed" if tense == "past_simple" else s
                if pol == "affirmative":
                    sent = f"I {w} today." if tense != "future_simple" else f"I will {w} tomorrow."
                elif pol == "negative":
                    if tense == "present_simple":
                        sent = f"I do not {w} today."
                    elif tense == "past_simple":
                        sent = f"I did not {w} yesterday."
                    else:
                        sent = f"I will not {w} tomorrow."
                else:
                    if tense == "present_simple":
                        sent = f"Do you {w} today?"
                    elif tense == "past_simple":
                        sent = f"Did you {w} yesterday?"
                    else:
                        sent = f"Will you {w} tomorrow?"
            else:
                w = s
                sent = {"affirmative": f"This is {w}.",
                        "negative": f"This is not {w}.",
                        "question": f"Is this {w}?"}[pol]
            rows.append({
                "drill_key": spec["drill_key"],
                "tense": tense,
                "polarity": pol,
                "sentence": sent,
                "surface": w,
                "base_hint": "",
            })
        if self.corrupt and rows:
            # surface that does NOT appear in the sentence => meaning drift
            rows[0]["surface"] = "completely_different_word"
        return rows


def _db(tmp_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(tmp_path / "w.db"))
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    conn.execute(
        "INSERT INTO concepts(id, domain, cefr, pos, gloss_en, rank) "
        "VALUES('GREET_HELLO','social','A1','verb','greet someone',1)"
    )
    conn.execute(
        "INSERT INTO concepts(id, domain, cefr, pos, gloss_en, rank) "
        "VALUES('WATER','nature','A1','noun','the liquid we drink',2)"
    )
    conn.execute(
        "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) "
        "VALUES('GREET_HELLO','en','greet','word','say hello')"
    )
    conn.execute(
        "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) "
        "VALUES('WATER','en','water','word','the liquid we drink')"
    )
    conn.commit()
    return conn


def test_matrix_bounded_by_pos() -> None:
    assert len(drill_matrix_for_pos("verb")) == 9   # 3 tenses x 3 polarities
    assert len(drill_matrix_for_pos("phrase")) == 9
    assert len(drill_matrix_for_pos("noun")) == 3   # present only
    assert len(drill_matrix_for_pos("adjective")) == 3
    keys = [s["drill_key"] for s in drill_matrix_for_pos("verb")]
    assert len(set(keys)) == 9
    assert keys[0] == "present_simple/affirmative"


def test_cache_first_single_call(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    provider = FakeProvider()
    pack1 = get_drill_pack(conn, "GREET_HELLO", "en", "general", provider)
    assert len(pack1.rows) == 9
    assert pack1.source == "fake"
    assert provider.calls == 1
    # second ask: served from the DB, no provider call
    pack2 = get_drill_pack(conn, "GREET_HELLO", "en", "general", provider)
    assert provider.calls == 1
    assert pack2.source == "cache"
    assert [r["sentence"] for r in pack1.rows] == [r["sentence"] for r in pack2.rows]
    # a different topic is a different cache key -> one more call
    pack3 = get_drill_pack(conn, "GREET_HELLO", "en", "business", provider)
    assert provider.calls == 2
    assert pack3.source == "fake"
    n = conn.execute("SELECT COUNT(*) FROM sentence_drills").fetchone()[0]
    assert n == 18
    conn.close()


def test_corrupt_pack_rejected_and_not_written(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    bad = FakeProvider(corrupt=True)
    with pytest.raises(DrillError):
        get_drill_pack(conn, "GREET_HELLO", "en", "general", bad)
    assert conn.execute("SELECT COUNT(*) FROM sentence_drills").fetchone()[0] == 0
    # a good provider still works afterwards (no poisoned state)
    good = FakeProvider()
    pack = get_drill_pack(conn, "GREET_HELLO", "en", "general", good)
    assert len(pack.rows) == 9
    conn.close()


def test_unknown_topic_rejected(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    with pytest.raises(DrillError):
        get_drill_pack(conn, "GREET_HELLO", "en", "kitchen", FakeProvider())
    conn.close()


def test_concept_without_english_anchor_rejected(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    conn.execute("INSERT INTO concepts(id, domain, cefr, pos, gloss_en, rank) VALUES('X','general','A1','verb','x',3)")
    conn.execute(
        "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) "
        "VALUES('X','vi','x-voi','word','x')"
    )
    conn.commit()
    with pytest.raises(DrillError):
        get_drill_pack(conn, "X", "en", "general", FakeProvider())
    conn.close()


def test_unknown_concept_raises_keyerror(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    with pytest.raises(KeyError):
        get_drill_pack(conn, "NOPE", "en", "general", FakeProvider())
    conn.close()


def test_drills_payload_schema_enforced() -> None:
    good = {"sentences": [{
        "drill_key": "present_simple/affirmative",
        "tense": "present_simple",
        "polarity": "affirmative",
        "sentence": "I greet you today.",
        "surface": "greet",
        "base_hint": "",
    }]}
    validate_payload("drills", good)
    bad_tense = dict(good, sentences=[{**good["sentences"][0], "tense": "yesterday"}])
    with pytest.raises(SchemaViolation):
        validate_payload("drills", bad_tense)
    bad_key = dict(good, sentences=[{**good["sentences"][0], "drill_key": "weird/key"}])
    with pytest.raises(SchemaViolation):
        validate_payload("drills", bad_key)
    with pytest.raises(SchemaViolation):
        validate_payload("drills", {"nope": 1})


def test_migration_is_additive(tmp_path: Path) -> None:
    conn = _db(tmp_path)
    n = conn.execute("SELECT COUNT(*) FROM expressions").fetchone()[0]
    init_schema(conn)  # re-run: must not duplicate or alter data
    assert n == conn.execute("SELECT COUNT(*) FROM expressions").fetchone()[0]
    conn.close()
