"""Device-token auth + per-device learning-progress store (Phase 2).

The server keeps mutable learning state (SRS grades/due dates) in
`out/progress.db`, separate from the immutable content warehouse. Devices
are unauthenticated (no password, MVP): the server issues an HMAC-signed
device token, stored in a cookie; every /api/srs call is validated against
it. Merge rule is "latest updated_at wins" per concept.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
from pathlib import Path
from typing import Any

from dict_factory.config import PROGRESS_DB, get_device_secret

PROGRESS_SCHEMA = """
CREATE TABLE IF NOT EXISTS device_tokens (
  device_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_progress (
  device_id TEXT NOT NULL,
  pair TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  grade TEXT NOT NULL,
  due TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, pair, concept_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_device_pair ON learning_progress(device_id, pair);
"""

# Hard cap on a single sync batch (protects the DB from runaway clients).
MAX_SYNC_BATCH = 2000


def ensure_progress_db(path: Path | None = None) -> None:
    db = path or PROGRESS_DB
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    try:
        conn.executescript(PROGRESS_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- device token (HMAC-signed, cookie-stored) ----------------------------

def issue_device_token(device_id: str | None = None) -> tuple[str, str]:
    """Return (device_id, token). `token = hex(HMAC_SHA256(secret, device_id))`.
    A new random device_id is generated when none is supplied."""
    secret = get_device_secret()
    did = device_id or secrets.token_urlsafe(16)
    token = hmac.new(secret.encode(), did.encode(), hashlib.sha256).hexdigest()
    return did, token


def verify_device_token(device_id: str, token: str) -> bool:
    """Constant-time check that `token` is the valid signature of `device_id`."""
    secret = get_device_secret()
    expected = hmac.new(secret.encode(), device_id.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, token)


def pair_key(base: str, target: str) -> str:
    return f"{base}_{target}"


# ---- progress upsert / read (latest updated_at wins) ----------------------

def upsert_entries(
    device_id: str,
    pair: str,
    entries: list[dict[str, Any]],
    db_path: Path | None = None,
) -> int:
    """Upsert SRS entries for a device+pair. An incoming row only overwrites
    an existing one when its updated_at is newer. Returns rows written."""
    if len(entries) > MAX_SYNC_BATCH:
        raise ValueError(f"sync batch too large ({len(entries)} > {MAX_SYNC_BATCH})")
    target_db = db_path or PROGRESS_DB
    ensure_progress_db(target_db)
    conn = sqlite3.connect(str(target_db))
    try:
        written = 0
        for e in entries:
            concept_id = str(e.get("concept_id") or "").strip()
            if not concept_id:
                continue
            cur = conn.execute(
                """
                INSERT INTO learning_progress(device_id, pair, concept_id, grade, due, updated_at)
                VALUES(?,?,?,?,?,?)
                ON CONFLICT(device_id, pair, concept_id) DO UPDATE SET
                  grade = excluded.grade,
                  due = excluded.due,
                  updated_at = excluded.updated_at
                WHERE excluded.updated_at > learning_progress.updated_at
                """,
                (device_id, pair, concept_id, str(e.get("grade", "")), str(e.get("due", "")), str(e.get("updated_at", ""))),
            )
            written += cur.rowcount
        conn.commit()
        return written
    finally:
        conn.close()


def read_entries(
    device_id: str, pair: str, db_path: Path | None = None
) -> dict[str, dict[str, str]]:
    """Return {concept_id: {grade, due, updated_at}} for a device+pair."""
    ensure_progress_db(db_path)
    conn = sqlite3.connect(str(db_path or PROGRESS_DB))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT concept_id, grade, due, updated_at
            FROM learning_progress WHERE device_id = ? AND pair = ?
            """,
            (device_id, pair),
        ).fetchall()
        return {r["concept_id"]: {"grade": r["grade"], "due": r["due"], "updated_at": r["updated_at"]} for r in rows}
    finally:
        conn.close()


def merge_local_with_server(
    local: dict[str, dict[str, str]],
    server: dict[str, dict[str, str]],
) -> dict[str, dict[str, str]]:
    """Client-side merge: per concept, keep whichever side has the newer
    updated_at (server wins on tie/missing local). Pure + testable."""
    merged: dict[str, dict[str, str]] = {}
    for cid, entry in server.items():
        merged[cid] = dict(entry)
    for cid, entry in local.items():
        local_ts = str(entry.get("updated_at", ""))
        server_ts = str(merged.get(cid, {}).get("updated_at", ""))
        if cid not in merged or local_ts >= server_ts:
            merged[cid] = dict(entry)
    return merged
