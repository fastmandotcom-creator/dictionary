from __future__ import annotations

import json
import sqlite3
from typing import Any

from dict_factory.db import get_db  # noqa: F401  (re-exported; single source in db.py)


def _tables(conn: sqlite3.Connection, names: set[str]) -> set[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    existing = {row[0] for row in rows}
    return existing & names


def _has_extra(conn: sqlite3.Connection) -> dict[str, bool]:
    present = _tables(conn, {"phonetics_text", "examples_bilingual", "units", "unit_items"})
    return {
        "phonetics": "phonetics_text" in present,
        "examples_bilingual": "examples_bilingual" in present,
        "units": "units" in present and "unit_items" in present,
    }


def learn_level_units(conn: sqlite3.Connection, base: str, target: str, cefr: str = "") -> list[dict[str, Any]]:
    flags = _has_extra(conn)
    units_filled = False
    if flags["units"]:
        params: list[Any] = [target]
        where = "u.target = ?"
        if cefr:
            where += " AND u.cefr = ?"
            params.append(cefr)
        rows = conn.execute(
            f"""
            SELECT u.id, u.target, u.cefr, u.order_no, u.title_json
            FROM units u
            WHERE {where}
            ORDER BY CASE u.cefr WHEN 'A1' THEN 0 WHEN 'A2' THEN 1 WHEN 'B1' THEN 2 WHEN 'B2' THEN 3 ELSE 4 END,
                     u.order_no
            """,
            params,
        ).fetchall()
        units_filled = len(rows) > 0
    if units_filled:
        result = []
        for row in rows:
            items = conn.execute(
                "SELECT concept_id, order_no FROM unit_items WHERE unit_id = ? ORDER BY order_no",
                (row["id"],),
            ).fetchall()
            result.append(
                {
                    "id": row["id"],
                    "cefr": row["cefr"],
                    "order_no": row["order_no"],
                    "title_json": row["title_json"],
                    "concept_ids": [i["concept_id"] for i in items],
                }
            )
        return result
    # Fallback: no units filled yet -> synthesize from concepts by cefr, ordered by rank.
    where_c = ""
    params_c: list[Any] = []
    if cefr:
        where_c = "WHERE c.cefr = ?"
        params_c.append(cefr)
    level_rows = conn.execute(
        f"""
        SELECT c.id, c.cefr, c.domain, c.rank
        FROM concepts c
        {where_c}
        ORDER BY c.rank
        """,
        params_c,
    ).fetchall()
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in level_rows:
        grouped.setdefault(row["cefr"], []).append(row)
    result = []
    for level in ("A1", "A2", "B1", "B2", "C1"):
        rows_in_level = grouped.get(level, [])
        if not rows_in_level:
            continue
        # chunk into units of up to 10, keep global rank order
        for start in range(0, len(rows_in_level), 10):
            chunk = rows_in_level[start : start + 10]
            order_no = start // 10 + 1
            result.append(
                {
                    "id": f"{target}-{level}-{order_no:02d}",
                    "cefr": level,
                    "order_no": order_no,
                    "title_json": json.dumps({base: f"{level} · Unit {order_no}", "en": f"{level} · Unit {order_no}"}),
                    "concept_ids": [c["id"] for c in chunk],
                }
            )
    return result


def learn_neighbors(
    conn: sqlite3.Connection,
    concept_id: str,
    target: str,
    *,
    levels: list[str] | None = None,
) -> dict[str, Any]:
    """Prev/next concept on the same path /learn and /session walk.

    Filled units: unit order, crossing the unit boundary.
    Empty units table (the live 12k set): CEFR then rank, same order as
    learn_level_units. `levels` keeps a CEFR or exam filter inside its band.
    """
    allowed = levels or ["A1", "A2", "B1", "B2", "C1"]
    placeholders = ",".join("?" for _ in allowed)
    flags = _has_extra(conn)
    units_filled = False
    if flags["units"]:
        units_filled = (
            conn.execute("SELECT COUNT(*) FROM units WHERE target = ?", (target,)).fetchone()[0] > 0
        )
    if units_filled:
        row = conn.execute(
            f"""
            WITH ordered AS (
              SELECT ui.concept_id AS concept_id,
                     ui.unit_id AS unit_id,
                     ROW_NUMBER() OVER (
                       ORDER BY CASE u.cefr
                         WHEN 'A1' THEN 1 WHEN 'A2' THEN 2 WHEN 'B1' THEN 3
                         WHEN 'B2' THEN 4 WHEN 'C1' THEN 5 ELSE 9 END,
                         u.order_no, ui.order_no, ui.concept_id
                     ) AS rn
              FROM unit_items ui
              JOIN units u ON u.id = ui.unit_id
              WHERE u.target = ? AND u.cefr IN ({placeholders})
            ),
            cur AS (
              SELECT rn, unit_id FROM ordered WHERE concept_id = ? ORDER BY rn LIMIT 1
            )
            SELECT
              (SELECT concept_id FROM ordered o WHERE o.rn = cur.rn - 1) AS prev_id,
              (SELECT concept_id FROM ordered o WHERE o.rn = cur.rn + 1) AS next_id,
              cur.unit_id AS unit_id
            FROM cur
            """,
            (target, *allowed, concept_id),
        ).fetchone()
    else:
        row = conn.execute(
            f"""
            WITH ordered AS (
              SELECT c.id AS concept_id,
                     ROW_NUMBER() OVER (
                       ORDER BY CASE c.cefr
                         WHEN 'A1' THEN 1 WHEN 'A2' THEN 2 WHEN 'B1' THEN 3
                         WHEN 'B2' THEN 4 WHEN 'C1' THEN 5 ELSE 9 END,
                         c.rank, c.id
                     ) AS rn
              FROM concepts c
              WHERE c.cefr IN ({placeholders})
            ),
            cur AS (
              SELECT rn FROM ordered WHERE concept_id = ? LIMIT 1
            )
            SELECT
              (SELECT concept_id FROM ordered o WHERE o.rn = cur.rn - 1) AS prev_id,
              (SELECT concept_id FROM ordered o WHERE o.rn = cur.rn + 1) AS next_id,
              NULL AS unit_id
            FROM cur
            """,
            (*allowed, concept_id),
        ).fetchone()
    if row is None:
        return {"prev": None, "next": None, "unit_id": None}
    return {"prev": row["prev_id"], "next": row["next_id"], "unit_id": row["unit_id"]}


def learn_concept_pair(
    conn: sqlite3.Connection, concept_id: str, base: str, target: str
) -> dict[str, Any] | None:
    concept = conn.execute("SELECT * FROM concepts WHERE id = ?", (concept_id,)).fetchone()
    if concept is None:
        return None
    flags = _has_extra(conn)

    def _text(lang: str) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT text, expression_type, meaning FROM expressions WHERE concept_id = ? AND lang = ?",
            (concept_id, lang),
        ).fetchone()
        return dict(row) if row else None

    target_row = _text(target)
    base_row = _text(base)
    phon = None
    if flags["phonetics"]:
        phon = conn.execute(
            "SELECT romaji, ipa FROM phonetics_text WHERE concept_id = ? AND lang = ?",
            (concept_id, target),
        ).fetchone()
        if phon:
            phon = dict(phon)
    biling = None
    if flags["examples_bilingual"]:
        biling = conn.execute(
            "SELECT sent_target, sent_base FROM examples_bilingual WHERE concept_id = ? AND lang_target = ? AND lang_base = ?",
            (concept_id, target, base),
        ).fetchone()
        if biling:
            biling = dict(biling)
    mono = None
    row = conn.execute(
        "SELECT sentence FROM examples WHERE concept_id = ? AND lang = ?",
        (concept_id, target),
    ).fetchone()
    if row and (row["sentence"] or "").strip():
        mono = row["sentence"]
    return {
        "concept": dict(concept),
        "target": target_row,
        "base": base_row,
        "phonetics": phon,
        "bilingual": biling,
        "mono": mono,
    }
