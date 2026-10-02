from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from dict_factory.config import WAREHOUSE_DB
from dict_factory.db import init_schema
from dict_factory.learn_queries import learn_concept_pair


def test_learn_detail_under_300ms(tmp_path: Path) -> None:
    db = tmp_path / "perf.db"
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    # seed enough concepts that a single lookup is not trivial
    for i in range(2000):
        conn.execute(
            "INSERT OR IGNORE INTO concepts(id, domain, cefr, pos, gloss_en, rank) VALUES(?,?,?,?,?,?)",
            (f"C{i:05d}", "d", "A1", "noun", f"gloss {i}", i + 1),
        )
        conn.execute(
            "INSERT OR REPLACE INTO expressions(concept_id, lang, text, expression_type, meaning) VALUES(?,?,?,?,?)",
            (f"C{i:05d}", "vi", f"vi {i}", "word", "g"),
        )
        conn.execute(
            "INSERT OR REPLACE INTO expressions(concept_id, lang, text, expression_type, meaning) VALUES(?,?,?,?,?)",
            (f"C{i:05d}", "ja", f"ja {i}", "word", "g"),
        )
    conn.commit()
    start = time.perf_counter()
    for i in range(200):
        learn_concept_pair(conn, f"C{i:05d}", base="vi", target="ja")
    elapsed_ms = (time.perf_counter() - start) * 1000
    conn.close()
    assert elapsed_ms / 200 < 300, f"avg {elapsed_ms / 200:.1f}ms exceeds 300ms"
