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


def next_batch(start_rank: int, batch_size: int, existing_ids: set[str]) -> list[dict]:
    avoid = ", ".join(sorted(existing_ids)[:80])
    user = (
        f"Generate exactly {batch_size} new concepts.\n"
        f"Assign ranks {start_rank} through {start_rank + batch_size - 1} in order.\n"
        f"Do not reuse these ids: {avoid or '(none)'}\n"
        "Cover everyday learner needs progressing by CEFR as rank grows."
    )
    payload = call_chat_json(SYSTEM, user, timeout=180.0)
    if not isinstance(payload, list):
        raise RuntimeError("syllabus batch must be a JSON array")
    parsed = [parse_concept(item) for item in payload]
    return parsed


def generate_syllabus(target: int, batch_size: int = 40, dest: Path | None = None) -> Path:
    path = dest or SYLLABUS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = load_existing(path)
    seen_ids = {row["id"] for row in existing}
    seen_ranks = {row["rank"] for row in existing}
    while len(existing) < target:
        start_rank = (max(seen_ranks) + 1) if seen_ranks else 1
        take = min(batch_size, target - len(existing))
        batch = next_batch(start_rank, take, seen_ids)
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
            raise RuntimeError("syllabus batch produced no new concepts")
        print(f"syllabus {len(existing)}/{target}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=int, default=12000)
    parser.add_argument("--batch-size", type=int, default=40)
    args = parser.parse_args()
    generate_syllabus(target=args.target, batch_size=args.batch_size)


if __name__ == "__main__":
    main()
