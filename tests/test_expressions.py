from __future__ import annotations

import pytest

from dict_factory.expressions import ExpressionError, parse_expression_bundle, runtime_pos
from dict_factory.languages import LANGUAGES


def _lang_entry(text: str = "word") -> dict[str, str]:
    return {
        "text": text,
        "type": "word",
        "meaning": "a gloss",
        "example": "A sentence.",
    }


def test_parse_requires_all_languages() -> None:
    langs = {lang: _lang_entry() for lang in LANGUAGES}
    langs.pop("vi")
    with pytest.raises(ExpressionError, match="missing langs"):
        parse_expression_bundle({"concept_id": "WATER", "langs": langs})


def test_parse_compact_keys() -> None:
    langs = {lang: {"t": lang, "m": "g"} for lang in LANGUAGES}
    bundle = parse_expression_bundle({"concept_id": "WATER", **langs})
    assert bundle["concept_id"] == "WATER"
    assert bundle["langs"]["en"]["text"] == "en"
    assert bundle["langs"]["en"]["example"] == ""


def test_parse_full_bundle() -> None:
    langs = {lang: _lang_entry(lang) for lang in LANGUAGES}
    langs["en"] = {
        "text": "take medicine",
        "type": "collocation",
        "meaning": "ingest prescribed drugs",
        "example": "You should take this medicine after meals.",
    }
    langs["vi"] = {
        "text": "uống thuốc",
        "type": "verb_expression",
        "meaning": "đưa thuốc vào cơ thể khi bệnh",
        "example": "Bạn nên uống thuốc này sau bữa ăn.",
    }
    bundle = parse_expression_bundle({"concept_id": "CONSUME_MEDICINE", "langs": langs})
    assert bundle["langs"]["vi"]["text"] == "uống thuốc"
    assert len(bundle["langs"]) == 35


def test_reject_overlong_text() -> None:
    with pytest.raises(ExpressionError, match="longer than"):
        parse_expression_bundle(
            {
                "concept_id": "X",
                "langs": {lang: _lang_entry("w" * 81) for lang in ("en",)},
            },
            langs=("en",),
        )


def test_runtime_pos_promotes_collocation() -> None:
    assert runtime_pos("verb", "collocation") == "phrase"
    assert runtime_pos("noun", "word") == "noun"
