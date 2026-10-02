from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from dict_factory import fill as fill_mod
from dict_factory.compile_runtime import compile_runtime
from dict_factory.db import init_schema
from dict_factory.extra_data import load_phonetics_map, parse_unit
from dict_factory.prompts import SchemaViolation, validate_payload


@pytest.fixture
def mini_syllabus(tmp_path: Path, monkeypatch) -> Path:
    syllabus = tmp_path / "syllabus.jsonl"
    syllabus.write_text(
        "".join(
            json.dumps({"id": cid, "domain": "social", "cefr": "A1", "pos": "phrase", "gloss_en": f"gloss {cid}", "rank": i + 1}) + "\n"
            for i, cid in enumerate(["HELLO_X", "BYE_X"])
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(fill_mod, "SYLLABUS_PATH", syllabus)
    out = tmp_path / "out" / "expressions"
    out.mkdir(parents=True)
    monkeypatch.setattr(fill_mod, "EXPRESSIONS_DIR", tmp_path / "out" / "expressions")
    return syllabus


def _bundle(cid: str, surface: str) -> dict:
    from dict_factory.languages import LANGUAGES

    langs = {c: {"text": f"{surface}-{c}", "meaning": f"m-{c}", "type": "word", "example": ""} for c in LANGUAGES}
    return {"concept_id": cid, "langs": langs}


def test_fill_rejects_invalid_llm_output_at_write_time(mini_syllabus: Path, tmp_path: Path, monkeypatch) -> None:
    expr = tmp_path / "out" / "expressions"
    (expr / "HELLO_X.json").write_text(json.dumps(_bundle("HELLO_X", "hello")))
    (expr / "BYE_X.json").write_text(json.dumps(_bundle("BYE_X", "bye")))

    def fake_llm(system: str, user: str, **kw):
        items = [
            {"id": "HELLO_X", "ro": "konnichiwa", "ipa": "[konnitɕiwa]"},
            {"id": "BYE_X", "ro": "BAD ROMAJI 日本語", "ipa": "not-ipa-日本語"},
        ]
        return [it for it in items if it["id"] in user]

    monkeypatch.setattr(fill_mod, "call_chat_json", fake_llm)
    n = fill_mod.fill_phonetics(target="ja", limit=10, batch_size=10, workers=1)
    assert n == 1
    assert (expr / "phonetics" / "ja" / "HELLO_X.json").exists()
    assert not (expr / "phonetics" / "ja" / "BYE_X.json").exists()


def test_fill_schema_violation_splits_and_keeps_pending(mini_syllabus: Path, tmp_path: Path, monkeypatch) -> None:
    expr = tmp_path / "out" / "expressions"
    (expr / "HELLO_X.json").write_text(json.dumps(_bundle("HELLO_X", "hello")))
    (expr / "BYE_X.json").write_text(json.dumps(_bundle("BYE_X", "bye")))
    calls = {"n": 0}

    def fake_llm(system: str, user: str, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"not": "an array"}  # whole-batch schema violation -> split
        if "HELLO_X" in user and "BYE_X" in user:
            raise AssertionError("should have split")
        cid = "HELLO_X" if "HELLO_X" in user else "BYE_X"
        return [{"id": cid, "ro": "konnichiwa", "ipa": "[konnitɕiwa]"}]

    monkeypatch.setattr(fill_mod, "call_chat_json", fake_llm)
    n = fill_mod.fill_phonetics(target="ja", limit=10, batch_size=10, workers=1)
    assert n == 2
    assert calls["n"] == 3  # 1 failed whole batch + 2 split singles


def test_fill_skips_concepts_without_target_surface(mini_syllabus: Path, tmp_path: Path, monkeypatch, capsys) -> None:
    expr = tmp_path / "out" / "expressions"
    # bundle has en/vi but NO ja entry content usable -> _target_surface None
    (expr / "HELLO_X.json").write_text(json.dumps({"concept_id": "HELLO_X", "langs": {
        "en": {"text": "hello", "meaning": "m", "type": "word", "example": ""},
        "vi": {"text": "xin chao", "meaning": "m", "type": "word", "example": ""},
    }}))

    def fake_llm(system: str, user: str, **kw):
        raise AssertionError(f"LLM must not be called for missing-surface concepts; got user={user[:80]}")

    monkeypatch.setattr(fill_mod, "call_chat_json", fake_llm)
    n = fill_mod.fill_phonetics(target="ja", limit=10, batch_size=10, workers=1, dry_run=True)
    assert n == 0
    out = capsys.readouterr().out
    assert "HELLO_X" in out and "gloss_en fallback" in out


def test_validate_payload_expressions_additional_properties() -> None:
    with pytest.raises(SchemaViolation):
        validate_payload("expressions", [{"id": "A_B", "langs": {}}])  # minProperties
    validate_payload("expressions", [{"id": "A_B", "langs": {"en": {"t": "x", "m": "y"}}}])


def test_compile_joins_readings_and_rejects_bad_bundle(tmp_path: Path) -> None:
    concepts = [
        {"id": "HELLO_X", "domain": "social", "cefr": "A1", "pos": "phrase", "gloss_en": "say hi", "rank": 1},
    ]
    bundles = {"HELLO_X": _bundle("HELLO_X", "hello")}
    dest = tmp_path / "rt.db"
    compile_runtime(concepts, bundles, dest=dest, phonetics={("HELLO_X", "ja"): "konnichiwa"})
    conn = sqlite3.connect(str(dest))
    row = conn.execute("SELECT readings FROM terms WHERE concept_id='HELLO_X' AND lang='ja'").fetchone()
    assert row[0] == "konnichiwa"
    row2 = conn.execute("SELECT readings FROM terms WHERE concept_id='HELLO_X' AND lang='vi'").fetchone()
    assert row2[0] is None
    conn.close()

    bad = {"HELLO_X": {"concept_id": "HELLO_X", "langs": {
        c: {"text": "x", "meaning": "m", "type": "word", "example": ""} for c in ("en",)
    }}}
    with pytest.raises(ValueError, match="missing vi expression|missing langs"):
        compile_runtime(concepts, bad, dest=tmp_path / "rt2.db")


def test_load_phonetics_map_empty_without_table(tmp_path: Path) -> None:
    conn = sqlite3.connect(str(tmp_path / "empty.db"))
    assert load_phonetics_map(conn) == {}
    conn.close()


def test_parse_unit_title_uses_target_key() -> None:
    unit, _items = parse_unit({"cefr": "A1", "title": "Chao hoi", "ids": ["A_B"]}, "ja", 1, "v1")
    assert json.loads(unit["title_json"]) == {"ja": "Chao hoi"}
