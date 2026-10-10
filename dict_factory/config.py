from __future__ import annotations

import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "out"
WAREHOUSE_DB = OUT_DIR / "warehouse.db"
SYLLABUS_PATH = OUT_DIR / "syllabus.jsonl"
EXPRESSIONS_DIR = OUT_DIR / "expressions"
RUNTIME_DB = OUT_DIR / "lexicon-core.db"
RUNTIME_DB_GZ = OUT_DIR / "lexicon-core.db.gz"

# Runtime learning-state store (device sync). Kept OUT of warehouse.db on
# purpose: warehouse is immutable content, this is mutable per-device state.
PROGRESS_DB = OUT_DIR / "progress.db"
DEVICE_SECRET_FILE = OUT_DIR / ".device_secret"


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


def get_device_secret() -> str:
    """HMAC secret signing device tokens. Env override wins; otherwise a
    random secret is generated once and persisted to OUT_DIR (0600)."""
    override = os.environ.get("DICT_DEVICE_SECRET", "").strip()
    if override:
        return override
    if not DEVICE_SECRET_FILE.exists():
        DEVICE_SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
        DEVICE_SECRET_FILE.write_text(secrets.token_hex(32), encoding="utf-8")
        try:
            DEVICE_SECRET_FILE.chmod(0o600)
        except OSError:
            pass
    return DEVICE_SECRET_FILE.read_text(encoding="utf-8").strip()
