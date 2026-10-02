from __future__ import annotations

import sqlite3
from pathlib import Path

from dict_factory.config import SCHEMA_PATH, WAREHOUSE_DB


def connect(path: Path | None = None) -> sqlite3.Connection:
    dest = path or WAREHOUSE_DB
    dest.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(dest)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    conn.commit()


def get_db(db_path: Path | None = None) -> sqlite3.Connection:
    """Read-only warehouse handle (row factory preset). Central accessor.

    web_queries/learn_queries re-export this; do not add a third copy.
    """
    conn = sqlite3.connect(db_path or WAREHOUSE_DB)
    conn.row_factory = sqlite3.Row
    return conn
