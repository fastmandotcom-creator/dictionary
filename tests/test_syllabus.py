from __future__ import annotations

import pytest

from dict_factory.syllabus import SyllabusError, parse_concept, parse_syllabus


def test_parse_valid_concept() -> None:
    concept = parse_concept(
        {
            "id": "CONSUME_MEDICINE",
            "domain": "health",
            "cefr": "A1",
            "pos": "phrase",
            "gloss_en": "ingest prescribed medicine",
            "rank": 1,
        }
    )
    assert concept["id"] == "CONSUME_MEDICINE"
    assert concept["rank"] == 1


def test_reject_invalid_id() -> None:
    with pytest.raises(SyllabusError, match="invalid concept id"):
        parse_concept(
            {
                "id": "take-medicine",
                "domain": "health",
                "cefr": "A1",
                "pos": "phrase",
                "gloss_en": "x",
                "rank": 1,
            }
        )


def test_reject_duplicate_rank() -> None:
    row = {
        "id": "LEARN",
        "domain": "education",
        "cefr": "A1",
        "pos": "verb",
        "gloss_en": "acquire knowledge",
        "rank": 1,
    }
    other = {**row, "id": "STUDY"}
    with pytest.raises(SyllabusError, match="duplicate rank"):
        parse_syllabus([row, other])
