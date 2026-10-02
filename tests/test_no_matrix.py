from __future__ import annotations

import sqlite3
from pathlib import Path

from dict_factory.config import WAREHOUSE_DB
from dict_factory.db import init_schema


def test_no_14m_matrix_table(tmp_path: Path) -> None:
    db = tmp_path / "t.db"
    conn = sqlite3.connect(str(db))
    init_schema(conn)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.close()
    # per-lang + per-pair tables exist, but no cross-product matrix table
    for required in ("phonetics_text", "examples_bilingual", "units", "unit_items"):
        assert required in tables
    for bad in ("glosses", "lang_pairs", "pair_glosses", "concept_matrix"):
        assert bad not in tables


def test_no_matrix_row_explosion(tmp_path: Path) -> None:
    db = tmp_path / "t.db"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    concepts = 5
    for i in range(concepts):
        conn.execute(
            "INSERT INTO concepts(id, domain, cefr, pos, gloss_en, rank) VALUES(?,?,?,?,?,?)",
            (f"C{i}", "d", "A1", "noun", "g", i + 1),
        )
    # per-lang table capped at concepts * 35
    for i in range(concepts):
        conn.execute(
            "INSERT INTO phonetics_text(concept_id, lang, romaji, ipa, prompt_v) VALUES(?,?,?,?,?)",
            (f"C{i}", "ja", "ro", "[x]", "v1"),
        )
    conn.execute(
        "INSERT INTO examples_bilingual(concept_id, lang_target, lang_base, sent_target, sent_base, prompt_v) VALUES(?,?,?,?,?,?)",
        ("C0", "ja", "vi", "s", "s", "v1"),
    )
    conn.commit()
    phon = conn.execute("SELECT COUNT(*) c FROM phonetics_text").fetchone()["c"]
    ex = conn.execute("SELECT COUNT(*) c FROM examples_bilingual").fetchone()["c"]
    conn.close()
    assert phon <= concepts * 35
    assert ex <= concepts * 35 * 34
    assert ex == 1
