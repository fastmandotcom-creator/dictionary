from __future__ import annotations

from pathlib import Path

import pytest

from dict_factory import progress
from dict_factory.web_server import app
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _isolated_progress_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Route tests share this too: never write to the real out/progress.db."""
    db = tmp_path / "progress.db"
    monkeypatch.setattr(progress, "PROGRESS_DB", db)
    return db


def test_issue_and_verify_token(_isolated_progress_db: Path) -> None:
    did, token = progress.issue_device_token()
    assert progress.verify_device_token(did, token)
    assert not progress.verify_device_token(did, "0" * 64)
    assert not progress.verify_device_token(did + "x", token)


def test_upsert_latest_wins(_isolated_progress_db: Path) -> None:
    did, _ = progress.issue_device_token()
    progress.upsert_entries(did, "vi_ja", [
        {"concept_id": "X", "grade": "hard", "due": "2026-01-01", "updated_at": "2026-01-01T00:00:00Z"},
    ])
    # newer overwrites
    progress.upsert_entries(did, "vi_ja", [
        {"concept_id": "X", "grade": "good", "due": "2026-01-08", "updated_at": "2026-01-02T00:00:00Z"},
    ])
    row = progress.read_entries(did, "vi_ja")["X"]
    assert row["grade"] == "good"
    # older does NOT overwrite
    progress.upsert_entries(did, "vi_ja", [
        {"concept_id": "X", "grade": "hard", "due": "2026-01-01", "updated_at": "2025-12-31T00:00:00Z"},
    ])
    row = progress.read_entries(did, "vi_ja")["X"]
    assert row["grade"] == "good"
    # pairs are isolated
    assert progress.read_entries(did, "vi_en") == {}


def test_batch_cap_enforced(_isolated_progress_db: Path) -> None:
    did, _ = progress.issue_device_token()
    big = [{"concept_id": f"C{i}", "grade": "ok", "due": "2026-01-01", "updated_at": "2026-01-01T00:00:00Z"}
           for i in range(progress.MAX_SYNC_BATCH + 1)]
    with pytest.raises(ValueError):
        progress.upsert_entries(did, "vi_ja", big)


def test_merge_local_with_server() -> None:
    local = {
        "A": {"grade": "good", "due": "2026-01-08", "updated_at": "2026-01-02T00:00:00Z"},
        "B": {"grade": "hard", "due": "2026-01-01", "updated_at": "2026-01-01T00:00:00Z"},
        "C": {"grade": "ok", "due": "2026-01-03", "updated_at": "2026-01-01T00:00:00Z"},
    }
    server = {
        "B": {"grade": "good", "due": "2026-01-08", "updated_at": "2026-01-05T00:00:00Z"},  # newer -> wins
        "C": {"grade": "hard", "due": "2026-01-01", "updated_at": "2025-12-30T00:00:00Z"},  # older -> local kept
        "D": {"grade": "ok", "due": "2026-01-03", "updated_at": "2026-01-04T00:00:00Z"},  # server-only -> added
    }
    merged = progress.merge_local_with_server(local, server)
    assert merged["A"]["grade"] == "good"   # local-only kept
    assert merged["B"]["grade"] == "good"   # server newer
    assert merged["C"]["grade"] == "ok"     # local newer
    assert merged["D"]["grade"] == "ok"     # server-only
    assert len(merged) == 4


# ---- routes --------------------------------------------------------------

def _client_with_device() -> TestClient:
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/api/sync/device")
    assert res.status_code == 200
    return client


def test_sync_device_issues_cookie() -> None:
    client = TestClient(app, raise_server_exceptions=False)
    res = client.get("/api/sync/device")
    assert res.status_code == 200
    assert "dict_device" in res.cookies
    # idempotent: re-issue with a valid cookie keeps the same device
    res2 = client.get("/api/sync/device")
    assert res2.json()["device_id"] == res.json()["device_id"]


def test_srs_get_requires_device() -> None:
    client = TestClient(app, raise_server_exceptions=False)  # no cookie
    assert client.get("/api/srs?base=vi&target=ja").status_code == 401


def test_srs_roundtrip_between_devices() -> None:
    """Same device token on two contexts -> shared SRS state (acceptance i).

    'Device A' records two cards. 'Device B' is a fresh context that adopts
    the SAME device cookie; B then reads back exactly what A recorded, and a
    newer upsert from B wins the merge."""
    a = _client_with_device()
    res = a.post("/api/srs/sync", json={
        "base": "vi", "target": "ja",
        "entries": [
            {"concept_id": "GREET_HELLO", "grade": "good", "due": "2026-01-08", "updated_at": "2026-01-01T00:00:00Z"},
            {"concept_id": "WATER", "grade": "hard", "due": "2026-01-01", "updated_at": "2026-01-01T00:00:00Z"},
        ],
    })
    assert res.status_code == 200
    assert set(res.json()["entries"]) == {"GREET_HELLO", "WATER"}

    # B is a new context but shares A's device cookie (same token).
    b = TestClient(app, raise_server_exceptions=False)
    b.cookies.set("dict_device", a.cookies.get("dict_device"))
    got = b.get("/api/srs?base=vi&target=ja")
    assert got.status_code == 200
    assert set(got.json()["entries"]) == {"GREET_HELLO", "WATER"}, "B must see A's state via the shared token"

    # B upserts a newer timestamp -> server merge keeps the newest.
    res = b.post("/api/srs/sync", json={
        "base": "vi", "target": "ja",
        "entries": [
            {"concept_id": "GREET_HELLO", "grade": "good", "due": "2026-01-08", "updated_at": "2026-01-02T00:00:00Z"},
        ],
    })
    assert res.status_code == 200
    assert res.json()["entries"]["GREET_HELLO"]["updated_at"] == "2026-01-02T00:00:00Z"


def test_srs_sync_batch_cap_400() -> None:
    client = _client_with_device()
    big = [
        {"concept_id": f"C{i}", "grade": "ok", "due": "2026-01-01", "updated_at": "2026-01-01T00:00:00Z"}
        for i in range(progress.MAX_SYNC_BATCH + 1)
    ]
    assert client.post("/api/srs/sync", json={"base": "vi", "target": "ja", "entries": big}).status_code == 400


def test_srs_sync_bad_shape_400() -> None:
    client = _client_with_device()
    assert client.post("/api/srs/sync", json={"base": "vi", "target": "ja", "entries": "not-a-list"}).status_code == 400
