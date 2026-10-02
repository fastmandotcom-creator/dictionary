from __future__ import annotations

import pytest

from dict_factory.generate_syllabus import adopt_batch, uniquify_id
from dict_factory.languages import DOMAIN_SET
from dict_factory.syllabus import (
    SyllabusError,
    normalize_domain,
    normalize_syllabus_file,
    parse_concept,
    parse_syllabus,
)


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


def test_uniquify_and_adopt_batch_forces_new_ranks() -> None:
    assert uniquify_id("WATER", {"WATER"}) == "WATER_2"
    adopted = adopt_batch(
        [
            {
                "id": "WATER",
                "domain": "nature",
                "cefr": "A1",
                "pos": "noun",
                "gloss_en": "liquid",
                "rank": 1,
            }
        ],
        start_rank=50,
        seen_ids={"WATER"},
    )
    assert adopted[0]["id"] == "WATER_2"
    assert adopted[0]["rank"] == 50


def _concept(domain: str) -> dict:
    return {
        "id": "TEST_X",
        "domain": domain,
        "cefr": "A1",
        "pos": "noun",
        "gloss_en": "x",
        "rank": 1,
    }


def test_reject_unknown_domain() -> None:
    with pytest.raises(SyllabusError, match="invalid domain"):
        parse_concept(_concept("food_drink"))
    with pytest.raises(SyllabusError, match="invalid domain"):
        parse_concept(_concept("whatever_nonsense"))


def test_accept_canonical_domains() -> None:
    assert len(DOMAIN_SET) == 38
    for domain in ("health", "food", "work", "home"):
        assert parse_concept(_concept(domain))["domain"] == domain


def test_normalize_domain_maps_legacy() -> None:
    assert normalize_domain("health") == "health"
    assert normalize_domain("food_drink") == "food"
    assert normalize_domain("workplace") == "work"
    assert normalize_domain("ARTS") == "arts"
    with pytest.raises(SyllabusError, match="unmapped legacy domain"):
        normalize_domain("not_a_domain")


def test_normalize_syllabus_file_rewrites_domains(tmp_path) -> None:
    from pathlib import Path

    import json

    path = Path(tmp_path) / "s.jsonl"
    path.write_text(
        json.dumps(_concept("food_drink")) + "\n" + json.dumps(_concept("health")) + "\n"
    )
    stats = normalize_syllabus_file(path)
    assert stats == {"changed": 1, "total": 2}
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert [row["domain"] for row in rows] == ["food", "health"]
