"""Server-side SRS logic shared between templates and tests.

Storage schema (localStorage, per language pair):
  key   = dict_srs_v2_{base}_{target}
  value = { concept_id: {"grade": "hard"|"ok"|"good", "due": "YYYY-MM-DD"} }

Legacy schema (v1, read-only migration):
  key   = dict_learn_progress_{base}_{target}
  value = { concept_id: "good" }   -- no due date; treated as due today
"""
from __future__ import annotations

from datetime import date, timedelta

GRADES = ("hard", "ok", "good")

# days until next review, per grade
GRADE_INTERVAL_DAYS = {"hard": 1, "ok": 3, "good": 7}


def srs_key(base: str, target: str) -> str:
    return f"dict_srs_v2_{base}_{target}"


def legacy_key(base: str, target: str) -> str:
    return f"dict_learn_progress_{base}_{target}"


def grade_interval_days(grade: str) -> int:
    if grade not in GRADES:
        raise ValueError(f"unknown grade {grade!r}")
    return GRADE_INTERVAL_DAYS[grade]


def next_due(grade: str, today: date | str) -> str:
    """ISO date string for the next review, given today's date."""
    t = date.fromisoformat(today) if isinstance(today, str) else today
    return (t + timedelta(days=grade_interval_days(grade))).isoformat()


def is_done(entry: dict | None, legacy_value: str | None = None) -> bool:
    """True when a card counts as learned (grade ok/good, not hard, not ungraded)."""
    if entry and entry.get("grade"):
        return entry["grade"] != "hard"
    return legacy_value == "good"


def is_due(entry: dict | None, today: str, legacy_value: str | None = None) -> bool:
    """True when a card should appear in today's review pool.

    "Due" means already learned and its review date has arrived: hard always
    resurfaces, ok/good only when entry.due <= today. A card that was NEVER
    learned (no entry, no legacy) is "new", not due — otherwise every
    unlearned word floods the review pool and repeats inside one session.
    Legacy v1 entries (no due date) come back for one pass.
    """
    if entry:
        grade = entry.get("grade")
        if not grade:
            return False
        if grade == "hard":
            return True
        due = entry.get("due")
        return due is None or due <= today
    if legacy_value:
        # v1 had no due date: migrated cards come back for one pass
        return True
    return False


def shuffle(seq: list, rng=None) -> list:
    """Fisher-Yates; deterministic when rng is supplied (tests)."""
    import random

    r = rng or random
    a = list(seq)
    for i in range(len(a) - 1, 0, -1):
        j = r.randint(0, i)
        a[i], a[j] = a[j], a[i]
    return a
