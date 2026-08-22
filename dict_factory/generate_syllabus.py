from __future__ import annotations

import argparse
import json
from pathlib import Path

from dict_factory.config import SYLLABUS_PATH
from dict_factory.llm import call_chat_json
from dict_factory.syllabus import parse_concept

SYSTEM = """You are a CEFR syllabus designer for a multilingual language-learning engine.
Emit pedagogical CONCEPTS (ideas people express), not an English word list and not WordNet synsets.
Mix roughly: 40% collocations/expressions, 25% verbs, 20% nouns, 10% adjectives/adverbs, 5% function words.
Return ONLY a JSON array of objects:
{"id":"SCREAMING_SNAKE","domain":"health","cefr":"A1","pos":"phrase","gloss_en":"...","rank":1}
Rules:
- id matches ^[A-Z][A-Z0-9_]+$ and is unique
- pos is one of noun, verb, adjective, adverb, phrase, other
- cefr is A1, A2, B1, B2, or C1
- rank is the global teaching order (1 = most basic)
- No duplicate ideas. No proper nouns, brands, or slang.
"""


def load_existing(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(parse_concept(json.loads(line)))
    return rows


def uniquify_id(concept_id: str, seen_ids: set[str]) -> str:
    if concept_id not in seen_ids:
        return concept_id
    suffix = 2
    while f"{concept_id}_{suffix}" in seen_ids:
        suffix += 1
    return f"{concept_id}_{suffix}"


def cefr_for_rank(rank: int) -> str:
    if rank <= 1500:
        return "A1"
    if rank <= 3500:
        return "A2"
    if rank <= 7000:
        return "B1"
    if rank <= 10000:
        return "B2"
    return "C1"


def adopt_batch(raw_items: list[dict], start_rank: int, seen_ids: set[str]) -> list[dict]:
    adopted: list[dict] = []
    used_this_batch: set[str] = set()
    for offset, item in enumerate(raw_items):
        concept_id = uniquify_id(item["id"], seen_ids | used_this_batch)
        used_this_batch.add(concept_id)
        adopted.append(
            {
                **item,
                "id": concept_id,
                "rank": start_rank + offset,
                "cefr": item["cefr"] if item["cefr"] else cefr_for_rank(start_rank + offset),
            }
        )
    return adopted


def next_batch(start_rank: int, batch_size: int, existing_ids: set[str], recent_glosses: list[str]) -> list[dict]:
    sample_ids = sorted(existing_ids)[-80:]
    user = (
        f"Generate exactly {batch_size} NEW concepts. You have already created {len(existing_ids)} concepts.\n"
        f"Use ranks {start_rank} through {start_rank + batch_size - 1}. Target CEFR {cefr_for_rank(start_rank)}.\n"
        f"Recent ids (do not repeat): {', '.join(sample_ids) or '(none)'}\n"
        f"Recent glosses (do not repeat ideas): {'; '.join(recent_glosses[-30:]) or '(none)'}\n"
        "Invent fresh everyday situations, collocations, and verbs. Do not restart from greetings."
    )
    payload = call_chat_json(SYSTEM, user, timeout=180.0)
    if not isinstance(payload, list):
        raise RuntimeError("syllabus batch must be a JSON array")
    parsed: list[dict] = []
    for index, item in enumerate(payload):
        try:
            parsed.append(parse_concept({**item, "rank": start_rank + index}))
        except Exception:
            continue
    return parsed


def generate_syllabus(target: int, batch_size: int = 120, dest: Path | None = None) -> Path:
    path = dest or SYLLABUS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = load_existing(path)
    seen_ids = {row["id"] for row in existing}
    seen_ranks = {row["rank"] for row in existing}
    empty_retries = 0
    while len(existing) < target:
        start_rank = (max(seen_ranks) + 1) if seen_ranks else 1
        take = min(batch_size, target - len(existing))
        batch = adopt_batch(
            next_batch(start_rank, take, seen_ids, [row["gloss_en"] for row in existing]),
            start_rank,
            seen_ids,
        )
        added = 0
        with path.open("a", encoding="utf-8") as handle:
            for item in batch:
                if item["id"] in seen_ids or item["rank"] in seen_ranks:
                    continue
                handle.write(json.dumps(item, ensure_ascii=False) + "\n")
                existing.append(item)
                seen_ids.add(item["id"])
                seen_ranks.add(item["rank"])
                added += 1
                if len(existing) >= target:
                    break
        if added == 0:
            empty_retries += 1
            if empty_retries >= 5:
                raise RuntimeError("syllabus batch produced no new concepts")
            continue
        empty_retries = 0
        print(f"syllabus {len(existing)}/{target}", flush=True)
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=int, default=12000)
    parser.add_argument("--batch-size", type=int, default=120)
    args = parser.parse_args()
    generate_syllabus(target=args.target, batch_size=args.batch_size)


if __name__ == "__main__":
    main()
