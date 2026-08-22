from __future__ import annotations

import sqlite3
from typing import Any

from dict_factory.config import WAREHOUSE_DB


def get_db(db_path=WAREHOUSE_DB) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def get_stats(conn: sqlite3.Connection) -> dict[str, Any]:
    total_concepts = conn.execute("SELECT count(*) FROM concepts").fetchone()[0]
    total_expressions = conn.execute("SELECT count(*) FROM expressions").fetchone()[0]
    total_examples = conn.execute("SELECT count(*) FROM examples").fetchone()[0]
    cefr_distribution = conn.execute(
        "SELECT cefr, count(*) as count FROM concepts GROUP BY cefr ORDER BY cefr"
    ).fetchall()
    domain_distribution = conn.execute(
        "SELECT domain, count(*) as count FROM concepts GROUP BY domain ORDER BY count DESC LIMIT 10"
    ).fetchall()
    return {
        "total_concepts": total_concepts,
        "total_expressions": total_expressions,
        "total_examples": total_examples,
        "cefr": [dict(r) for r in cefr_distribution],
        "domains": [dict(r) for r in domain_distribution],
    }


def search_concepts(
    conn: sqlite3.Connection,
    q: str = "",
    lang: str = "",
    cefr: str = "",
    pos: str = "",
    domain: str = "",
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[dict[str, Any]], int]:
    offset = (page - 1) * page_size
    conditions = []
    params = []

    q_clean = q.strip()
    if q_clean:
        if lang:
            conditions.append(
                """c.id IN (
                    SELECT concept_id FROM expressions 
                    WHERE lang = ? AND (text LIKE ? OR meaning LIKE ?)
                )"""
            )
            params.extend([lang, f"%{q_clean}%", f"%{q_clean}%"])
        else:
            conditions.append(
                """(
                    c.id LIKE ? OR c.gloss_en LIKE ? OR c.id IN (
                        SELECT concept_id FROM expressions 
                        WHERE text LIKE ? OR meaning LIKE ?
                    )
                )"""
            )
            params.extend([f"%{q_clean}%", f"%{q_clean}%", f"%{q_clean}%", f"%{q_clean}%"])

    if cefr:
        conditions.append("c.cefr = ?")
        params.append(cefr)
    if pos:
        conditions.append("c.pos = ?")
        params.append(pos)
    if domain:
        conditions.append("c.domain = ?")
        params.append(domain)

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    count_sql = f"SELECT count(*) FROM concepts c {where_clause}"
    total = conn.execute(count_sql, params).fetchone()[0]

    sql = f"""
    SELECT 
        c.id, c.domain, c.cefr, c.pos, c.gloss_en, c.rank,
        e_en.text as en_text, e_en.meaning as en_meaning,
        e_vi.text as vi_text, e_vi.meaning as vi_meaning,
        e_ja.text as ja_text, e_ja.meaning as ja_meaning,
        e_zh.text as zh_text, e_zh.meaning as zh_meaning
    FROM concepts c
    LEFT JOIN expressions e_en ON e_en.concept_id = c.id AND e_en.lang = 'en'
    LEFT JOIN expressions e_vi ON e_vi.concept_id = c.id AND e_vi.lang = 'vi'
    LEFT JOIN expressions e_ja ON e_ja.concept_id = c.id AND e_ja.lang = 'ja'
    LEFT JOIN expressions e_zh ON e_zh.concept_id = c.id AND e_zh.lang = 'zh'
    {where_clause}
    ORDER BY c.rank ASC
    LIMIT ? OFFSET ?
    """
    rows = conn.execute(sql, (*params, page_size, offset)).fetchall()
    return [dict(r) for r in rows], total


def get_concept_detail(conn: sqlite3.Connection, concept_id: str) -> dict[str, Any] | None:
    concept = conn.execute(
        "SELECT id, domain, cefr, pos, gloss_en, rank FROM concepts WHERE id = ?",
        (concept_id,),
    ).fetchone()
    if not concept:
        return None

    expressions = conn.execute(
        """
        SELECT 
            e.concept_id, e.lang, e.text, e.expression_type, e.meaning,
            ex.id as example_id, ex.sentence as example_sentence
        FROM expressions e
        LEFT JOIN examples ex ON ex.concept_id = e.concept_id AND ex.lang = e.lang
        WHERE e.concept_id = ?
        ORDER BY e.lang
        """,
        (concept_id,),
    ).fetchall()

    return {
        "concept": dict(concept),
        "expressions": [dict(e) for e in expressions],
    }
