from __future__ import annotations

import json
import re
from typing import Any

from dict_factory.languages import CEFR_LEVELS, CONCEPT_ID_PATTERN, POS_VALUES

CONCEPT_ID_RE = re.compile(CONCEPT_ID_PATTERN)


class SyllabusError(ValueError):
    pass


def parse_concept(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise SyllabusError("concept must be an object")
    concept_id = str(raw.get("id") or "").strip()
    if not CONCEPT_ID_RE.fullmatch(concept_id):
        raise SyllabusError(f"invalid concept id: {concept_id!r}")
    domain = str(raw.get("domain") or "").strip()
    if not domain:
        raise SyllabusError(f"{concept_id}: missing domain")
    cefr = str(raw.get("cefr") or "").strip().upper()
    if cefr not in CEFR_LEVELS:
        raise SyllabusError(f"{concept_id}: invalid cefr {cefr!r}")
    pos = str(raw.get("pos") or "").strip().lower()
    if pos not in POS_VALUES:
        raise SyllabusError(f"{concept_id}: invalid pos {pos!r}")
    gloss_en = str(raw.get("gloss_en") or "").strip()
    if not gloss_en:
        raise SyllabusError(f"{concept_id}: missing gloss_en")
    try:
        rank = int(raw.get("rank"))
    except (TypeError, ValueError) as exc:
        raise SyllabusError(f"{concept_id}: invalid rank") from exc
    if rank < 1:
        raise SyllabusError(f"{concept_id}: rank must be >= 1")
    return {
        "id": concept_id,
        "domain": domain,
        "cefr": cefr,
        "pos": pos,
        "gloss_en": gloss_en,
        "rank": rank,
    }


def parse_syllabus(rows: list[Any]) -> list[dict[str, Any]]:
    concepts = [parse_concept(row) for row in rows]
    ranks = [c["rank"] for c in concepts]
    if len(set(ranks)) != len(ranks):
        raise SyllabusError("duplicate rank in syllabus")
    ids = [c["id"] for c in concepts]
    if len(set(ids)) != len(ids):
        raise SyllabusError("duplicate concept id in syllabus")
    return concepts


def load_syllabus_jsonl(text: str) -> list[dict[str, Any]]:
    rows: list[Any] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return parse_syllabus(rows)
