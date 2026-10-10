"""Server-side helpers for the daily learning session (Phase 1).

Everything here is pure data shaping — no localStorage, no HTTP. The client
holds the SRS store (srs.js); these functions decide WHICH concepts belong in
today's session and build the placement quiz, so both sides stay testable.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any

CEFR_LEVELS = ("A1", "A2", "B1", "B2", "C1")


def _rng_for(seed_str: str):
    import random

    # Stable, deterministic RNG from the SHA256 of a string (session seed
    # = "base|target|YYYY-MM-DD" for daily session, "...|quiz" for placement).
    digest = hashlib.sha256(seed_str.encode()).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def estimate_start_level(correct: int, total: int) -> str:
    """Map overall placement performance to a CEFR starting level.

    >=80% correct starts at B1; 50–79% at A2; below 50% (or no answers)
    at A1. No guessing when the quiz is empty.
    """
    if total == 0:
        return "A1"
    rate = correct / total
    if rate >= 0.8:
        return "B1"
    if rate >= 0.5:
        return "A2"
    return "A1"


def build_placement_questions(
    conn: sqlite3.Connection, base: str, target: str, count: int = 10
) -> list[dict[str, Any]]:
    """Deterministic quiz: 4 easy (A1–A2) + 6 hard (B1–C1) concepts of `target`.

    Each question shows the target-language expression and offers 4 choices
    in the learner's base language (the right one + 3 distractors from the
    same band). The whole quiz is seeded from (base, target), so the same
    pair always produces the same questions in the same order.
    """
    rng = _rng_for(f"{base}|{target}|placement")

    def _pool(levels: tuple[str, ...]) -> list[dict[str, Any]]:
        rows = conn.execute(
            f"""
            SELECT c.id, c.cefr, e_target.text AS target_text, e_base.text AS base_text
            FROM concepts c
            JOIN expressions e_target ON e_target.concept_id = c.id AND e_target.lang = ?
            JOIN expressions e_base ON e_base.concept_id = c.id AND e_base.lang = ?
            WHERE c.cefr IN ({','.join('?' for _ in levels)})
              AND e_target.text IS NOT NULL AND e_base.text IS NOT NULL
            """,
            (target, base, *levels),
        ).fetchall()
        return [dict(r) for r in rows]

    easy_pool = _pool(("A1", "A2"))
    hard_pool = _pool(("B1", "B2", "C1"))
    easy = rng.sample(easy_pool, min(4, len(easy_pool))) if easy_pool else []
    used = {c["id"] for c in easy}
    hard_candidates = [c for c in hard_pool if c["id"] not in used]
    hard = rng.sample(hard_candidates, min(6, len(hard_candidates)))

    questions: list[dict[str, Any]] = []
    for item, band in [(c, "easy") for c in easy] + [(c, "hard") for c in hard]:
        # 3 distractors: same-band first, fall back to any other band if thin.
        same_band = [c for c in easy_pool if c["cefr"] == item["cefr"] and c["id"] != item["id"]]
        distractor_pool = same_band if len(same_band) >= 3 else [
            c for c in easy_pool + hard_pool if c["id"] != item["id"] and c["base_text"] != item["base_text"]
        ]
        distractors = rng.sample(distractor_pool, min(3, len(distractor_pool)))
        options = [item["base_text"]]
        for d in distractors:
            if d["base_text"] not in options:
                options.append(d["base_text"])
        if len(options) < 4:
            continue  # not enough distinct choices yet — skip the question
        rng.shuffle(options)
        questions.append(
            {
                "conceptId": item["id"],
                "cefr": item["cefr"],
                "band": band,
                "prompt": item["target_text"],
                "options": options,
                "answer": item["base_text"],
            }
        )
    return questions[:count]


def item_band_cefr(conn: sqlite3.Connection, concept_id: str) -> str:
    row = conn.execute("SELECT cefr FROM concepts WHERE id = ?", (concept_id,)).fetchone()
    return row["cefr"] if row else "A1"


def session_queue(
    conn: sqlite3.Connection,
    base: str,
    target: str,
    cefr: str = "",
    exam: str = "",
    new_count: int = 10,
) -> dict[str, Any]:
    """Build today's queue on the server.

    - `units`: all units in scope (exam range or single cefr or all levels),
      each with its concept ids, so the client can decide which are new vs
      done (SRS store) and gate unit advancement.
    - `new_ids`: the first `new_count` not-yet-mastered concepts of the next
      active unit (client computes mastery from the SRS store and passes it).
    - `due_hint`: count estimate is client-side (due depends on SRS store).
    """
    from dict_factory.exam_levels import cefr_range_levels, resolve_exam_range

    if exam:
        resolved = resolve_exam_range(conn, exam)
        if resolved is None:
            raise ValueError(f"unknown exam level {exam!r}")
        levels = cefr_range_levels(*resolved)
    elif cefr:
        levels = [cefr]
    else:
        levels = list(CEFR_LEVELS)

    from dict_factory.learn_queries import learn_level_units

    units = []
    for level in levels:
        for unit in learn_level_units(conn, base, target, level):
            units.append(
                {
                    "id": unit["id"],
                    "cefr": unit["cefr"],
                    "order_no": unit["order_no"],
                    "title_json": unit["title_json"],
                    "concept_ids": unit["concept_ids"],
                }
            )
    return {
        "base": base,
        "target": target,
        "cefr": cefr,
        "exam": exam,
        "levels": levels,
        "units": units,
        "new_count": new_count,
    }


def estimate_session_minutes(new_ids: int, due_ids: int, seconds_per_card: int = 20) -> int:
    total = (new_ids + due_ids) * seconds_per_card
    return max(1, round(total / 60)) if (new_ids + due_ids) > 0 else 0
