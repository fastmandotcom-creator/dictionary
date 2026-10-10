from __future__ import annotations

import sqlite3
from typing import Any

from dict_factory.languages import CEFR_ORDER

# Internal provenance tags only. Never rendered to end users:
# levels are difficulty buckets for content routing, not exam promises.
EXAM_SOURCES = frozenset(
    {
        "IELTS-official",
        "TOEIC-official",
        "HSK-official",
        "TOPIK-official",
        "CEFR-native",
        "community-estimate",
    }
)

# Framework code -> spec. `levels` is the closed enum of level codes.
# `mapping_table` is the published correspondence, pasted verbatim as the
# LLM seed context (copy-transcribe task, never open generation).
EXAM_FRAMEWORKS: dict[str, dict[str, Any]] = {
    "DELF": {
        "lang": "fr",
        "name": "DELF-DALF",
        "source": "CEFR-native",
        "levels": ["A1", "A2", "B1", "B2", "C1"],
        "mapping_table": (
            "A1 | DELF A1 | A1-A1\n"
            "A2 | DELF A2 | A2-A2\n"
            "B1 | DELF B1 | B1-B1\n"
            "B2 | DELF B2 | B2-B2\n"
            "C1 | DALF C1 | C1-C1"
        ),
    },
    "GOETHE": {
        "lang": "de",
        "name": "Goethe-Zertifikat / telc",
        "source": "CEFR-native",
        "levels": ["A1", "A2", "B1", "B2", "C1"],
        "mapping_table": (
            "A1 | Goethe A1 | A1-A1\n"
            "A2 | Goethe A2 | A2-A2\n"
            "B1 | Goethe B1 | B1-B1\n"
            "B2 | Goethe B2 | B2-B2\n"
            "C1 | Goethe C1 | C1-C1"
        ),
    },
    "DELE": {
        "lang": "es",
        "name": "DELE",
        "source": "CEFR-native",
        "levels": ["A1", "A2", "B1", "B2", "C1"],
        "mapping_table": (
            "A1 | DELE A1 | A1-A1\n"
            "A2 | DELE A2 | A2-A2\n"
            "B1 | DELE B1 | B1-B1\n"
            "B2 | DELE B2 | B2-B2\n"
            "C1 | DELE C1 | C1-C1"
        ),
    },
    "CELI": {
        "lang": "it",
        "name": "CELI / CILS",
        "source": "CEFR-native",
        "levels": ["A1", "A2", "B1", "B2", "C1"],
        "mapping_table": (
            "A1 | A1 | A1-A1\n"
            "A2 | A2 | A2-A2\n"
            "B1 | B1 | B1-B1\n"
            "B2 | B2 | B2-B2\n"
            "C1 | C1 | C1-C1"
        ),
    },
    "CELPE": {
        "lang": "pt",
        "name": "CELPE-Bras",
        "source": "CEFR-native",
        "levels": ["Intermediario", "Intermediario-Superior", "Avancado", "Avancado-Superior"],
        "mapping_table": (
            "Intermediario | Intermediário | B1-B1\n"
            "Intermediario-Superior | Intermediário Superior | B2-B2\n"
            "Avancado | Avançado | C1-C1\n"
            "Avancado-Superior | Avançado Superior | C1-C1"
        ),
    },
    "IELTS": {
        "lang": "en",
        "name": "IELTS Academic",
        "source": "IELTS-official",
        "levels": ["4.0", "5.0", "6.0", "7.0", "8.0"],
        "mapping_table": (
            "4.0 | Band 4.0 | B1-B1\n"
            "5.0 | Band 5.0 | B1-B1\n"
            "6.0 | Band 6.0 | B2-B2\n"
            "7.0 | Band 7.0 | C1-C1\n"
            "8.0 | Band 8.0 | C1-C1"
        ),
    },
    "TOEIC": {
        "lang": "en",
        "name": "TOEIC Listening & Reading",
        "source": "TOEIC-official",
        "levels": ["255", "400", "600", "785", "900"],
        "mapping_table": (
            "255 | 255-400 | A2-A2\n"
            "400 | 400-600 | B1-B1\n"
            "600 | 600-780 | B2-B2\n"
            "785 | 785-900 | C1-C1\n"
            "900 | 900-990 | C1-C1"
        ),
    },
    "JLPT": {
        "lang": "ja",
        "name": "Japanese-Language Proficiency Test",
        "source": "community-estimate",
        "levels": ["N5", "N4", "N3", "N2", "N1"],
        "mapping_table": (
            "N5 | N5 | A1-A1\n"
            "N4 | N4 | A2-A2\n"
            "N3 | N3 | A2-B1\n"
            "N2 | N2 | B1-B2\n"
            "N1 | N1 | B2-C1"
        ),
    },
    "HSK": {
        "lang": "zh",
        "name": "HSK",
        "source": "HSK-official",
        "levels": ["HSK-1", "HSK-2", "HSK-3", "HSK-4", "HSK-5", "HSK-6"],
        "mapping_table": (
            "HSK-1 | HSK 1 | A1-A1\n"
            "HSK-2 | HSK 2 | A2-A2\n"
            "HSK-3 | HSK 3 | B1-B1\n"
            "HSK-4 | HSK 4 | B2-B2\n"
            "HSK-5 | HSK 5 | C1-C1\n"
            "HSK-6 | HSK 6 | C1-C1"
        ),
    },
    "TOPIK": {
        "lang": "ko",
        "name": "TOPIK",
        "source": "TOPIK-official",
        "levels": ["TOPIK-1", "TOPIK-2", "TOPIK-3", "TOPIK-4", "TOPIK-5", "TOPIK-6"],
        "mapping_table": (
            "TOPIK-1 | TOPIK 1 | A1-A1\n"
            "TOPIK-2 | TOPIK 2 | A2-A2\n"
            "TOPIK-3 | TOPIK 3 | B1-B1\n"
            "TOPIK-4 | TOPIK 4 | B2-B2\n"
            "TOPIK-5 | TOPIK 5 | C1-C1\n"
            "TOPIK-6 | TOPIK 6 | C1-C1"
        ),
    },
}


def parse_exam_ref(exam: str) -> tuple[str, str] | None:
    """Split an 'FW_CODE' ref like 'JLPT_N3' into (framework, level)."""
    if "_" not in exam:
        return None
    framework, _, code = exam.partition("_")
    if not framework or not code:
        return None
    return framework, code


def _has_exam_tables(conn: sqlite3.Connection) -> bool:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    names = {r[0] for r in rows}
    return "exam_framework" in names and "exam_level" in names


def list_exam_levels(conn: sqlite3.Connection, lang: str | None = None) -> list[dict[str, Any]]:
    """Seeded exam levels for UI dropdowns, easiest first per framework.

    Pass `lang` to restrict to the target language's frameworks (e.g. `ja`
    yields only JLPT). Omit to list every framework. Each row carries a
    `display` field: the label as-is when it already names the framework
    ("DELE A1"), otherwise prefixed with the framework code ("JLPT N5") —
    so the UI never renders "DELE DELE A1".
    """
    if not _has_exam_tables(conn):
        return []
    if lang:
        rows = conn.execute(
            """
            SELECT el.framework, el.code, el.label
            FROM exam_level el
            JOIN exam_framework ef ON ef.code = el.framework
            WHERE ef.lang = ?
            ORDER BY el.framework, el.sort_no
            """,
            (lang,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT framework, code, label FROM exam_level ORDER BY framework, sort_no"
        ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        item = dict(r)
        label = item["label"]
        code = item["framework"]
        item["display"] = label if label.upper().startswith(code) else f"{code} {label}"
        out.append(item)
    return out


def exam_frameworks_for_lang(conn: sqlite3.Connection, lang: str) -> list[str]:
    """Framework codes that have seeded levels for `lang` (e.g. `ja` -> `['JLPT']`)."""
    if not _has_exam_tables(conn):
        return []
    rows = conn.execute(
        "SELECT code FROM exam_framework WHERE lang = ? ORDER BY code", (lang,)
    ).fetchall()
    return [r["code"] for r in rows]


def resolve_exam_range(conn: sqlite3.Connection, exam: str) -> tuple[str, str] | None:
    """Resolve 'FW_CODE' to a (cefr_lo, cefr_hi) range. None if unknown."""
    if not _has_exam_tables(conn):
        return None
    parsed = parse_exam_ref(exam)
    if parsed is None:
        return None
    framework, code = parsed
    row = conn.execute(
        "SELECT cefr_lo, cefr_hi FROM exam_level WHERE framework = ? AND code = ?",
        (framework, code),
    ).fetchone()
    if row is None:
        return None
    return row["cefr_lo"], row["cefr_hi"]


def cefr_range_levels(lo: str, hi: str) -> list[str]:
    """CEFR levels from lo to hi inclusive, in difficulty order."""
    order = sorted(CEFR_ORDER, key=lambda k: CEFR_ORDER[k])
    try:
        return order[order.index(lo) : order.index(hi) + 1]
    except ValueError:
        return []
