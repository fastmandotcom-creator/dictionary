"""Restore a working dict_factory data directory (out/) from the committed bundle.

Run on a fresh machine after cloning:

    python3 bootstrap.py          # restores out/ + .env
    python3 -m dict_factory web   # now works

What it does (idempotent, safe to re-run):
  - gunzip data/warehouse.db.gz      -> out/warehouse.db   (the learning app's DB)
  - gunzip data/lexicon-core.db.gz   -> out/lexicon-core.db (+ .gz) (extension seed)
  - gunzip data/progress.db.gz       -> out/progress.db    (learning progress)
  - copy   data/syllabus.jsonl       -> out/syllabus.jsonl
  - untar  data/expressions.tar.gz   -> out/expressions/   (pipeline inputs)
  - copy   secrets/llm.env           -> .env   (only if .env is absent)

Everything the code needs lives in the repo after this, so the project runs
100% offline from a clone. The LLM data-*generation* pipeline additionally
needs the local gateway at LEXICON_LLM_BASE_URL (see secrets/llm.env) to be
reachable on the target machine.
"""
from __future__ import annotations

import gzip
import os
import shutil
import sqlite3
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = ROOT / "out"
SECRETS = ROOT / "secrets"


def _gunzip(src: Path, dest: Path) -> bool:
    """Restore dest from src only when dest is missing (never clobber live data)."""
    if dest.exists():
        print(f"  keep    out/{dest.name} already present")
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  gunzip  {src.name} -> out/{dest.name}")
    with gzip.open(src, "rb") as fin, open(dest, "wb") as fout:
        shutil.copyfileobj(fin, fout)
    return True


def _copy(src: Path, dest: Path) -> bool:
    if dest.exists():
        print(f"  keep    {dest.name} already present")
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)
    print(f"  copy    {src.name} -> {dest}")
    return True


def _check_db(path: Path, table: str, label: str) -> None:
    conn = sqlite3.connect(str(path))
    try:
        n = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"  ok      {path.name}: {n} {label}")
    finally:
        conn.close()


def main() -> int:
    for required in (
        DATA / "warehouse.db.gz",
        DATA / "lexicon-core.db.gz",
        DATA / "syllabus.jsonl",
        DATA / "expressions.tar.gz",
    ):
        if not required.exists():
            print(f"ERROR: missing {required} — is this the repo root?", file=sys.stderr)
            return 1

    print("Restoring data bundle -> out/ (missing files only; live data kept)...")
    _gunzip(DATA / "warehouse.db.gz", OUT / "warehouse.db")
    _gunzip(DATA / "lexicon-core.db.gz", OUT / "lexicon-core.db")
    _copy(DATA / "lexicon-core.db.gz", OUT / "lexicon-core.db.gz")
    if (DATA / "progress.db.gz").exists():
        _gunzip(DATA / "progress.db.gz", OUT / "progress.db")

    _copy(DATA / "syllabus.jsonl", OUT / "syllabus.jsonl")

    expr_dir = OUT / "expressions"
    if expr_dir.exists():
        print(f"  keep    out/expressions/ already present")
    else:
        print("  untar   expressions.tar.gz -> out/expressions/")
        with tarfile.open(DATA / "expressions.tar.gz", "r:gz") as tf:
            tf.extractall(OUT)

    # sanity: any restored/kept DB must open and hold its tables
    _check_db(OUT / "warehouse.db", "expressions", "expressions")
    _check_db(OUT / "lexicon-core.db", "terms", "terms")

    # restore .env only when absent (never clobber a machine-specific one)
    _copy(SECRETS / "llm.env", ROOT / ".env") if (SECRETS / "llm.env").exists() else None
    print("  (secrets/llm.env -> .env restored when missing)")

    print("\nDone. Next steps:")
    print("  python3 -m dict_factory web            # serve the learning app")
    print("  python3 -m dict_factory compile        # (re)build lexicon-core.db if needed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
