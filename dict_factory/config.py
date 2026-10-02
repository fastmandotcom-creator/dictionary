from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "out"
WAREHOUSE_DB = OUT_DIR / "warehouse.db"
SYLLABUS_PATH = OUT_DIR / "syllabus.jsonl"
EXPRESSIONS_DIR = OUT_DIR / "expressions"
RUNTIME_DB = OUT_DIR / "lexicon-core.db"
RUNTIME_DB_GZ = OUT_DIR / "lexicon-core.db.gz"


def _frontend_dir() -> Path:
    override = os.environ.get("LEXICON_FRONTEND_DIR", "").strip()
    if override:
        return Path(override)
    return Path(
        "/Users/admin/Documents/Fumihiko/livecode-extension/frontend-extension/public/vocabulary"
    )


FRONTEND_SEED_GZ = _frontend_dir() / "lexicon-core.db.gz"
FRONTEND_SEED_DB = _frontend_dir() / "lexicon-core.db"
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"
