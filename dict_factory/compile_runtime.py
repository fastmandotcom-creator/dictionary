from __future__ import annotations

import gzip
import json
import shutil
import sqlite3
from pathlib import Path

from dict_factory.config import FRONTEND_SEED_DB, FRONTEND_SEED_GZ, RUNTIME_DB, RUNTIME_DB_GZ
from dict_factory.expressions import runtime_pos
from dict_factory.languages import LANGUAGES

CORE_SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE concepts (
  id TEXT PRIMARY KEY,
  pos TEXT NOT NULL,
  meaning TEXT NOT NULL,
  meaning_lang TEXT NOT NULL DEFAULT 'en'
);
CREATE TABLE terms (
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  meaning TEXT,
  rank INTEGER NOT NULL,
  readings TEXT,
  PRIMARY KEY (concept_id, lang)
);
CREATE INDEX idx_terms_lang_rank ON terms(lang, rank);
"""


def compile_runtime(
    concepts: list[dict],
    bundles: dict[str, dict],
    dest: Path | None = None,
) -> Path:
    dest = dest or RUNTIME_DB
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    conn = sqlite3.connect(dest)
    try:
        conn.executescript(CORE_SCHEMA)
        concept_rows: list[tuple[str, str, str, str]] = []
        term_rows: list[tuple[str, str, str, str, int, None]] = []
        for concept in sorted(concepts, key=lambda item: item["rank"]):
            bundle = bundles.get(concept["id"])
            if bundle is None:
                raise ValueError(f"missing expressions for {concept['id']}")
            en_type = bundle["langs"]["en"]["type"]
            pos = runtime_pos(concept["pos"], en_type)
            concept_rows.append((concept["id"], pos, concept["gloss_en"], "en"))
            for lang in LANGUAGES:
                entry = bundle["langs"][lang]
                term_rows.append(
                    (
                        concept["id"],
                        lang,
                        entry["text"],
                        entry["meaning"],
                        int(concept["rank"]),
                        None,
                    )
                )
        conn.execute("INSERT INTO meta(key, value) VALUES('version', '2')")
        conn.execute("INSERT INTO meta(key, value) VALUES('count', ?)", (str(len(concept_rows)),))
        conn.execute("INSERT INTO meta(key, value) VALUES('topN', ?)", (str(len(concept_rows)),))
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('languages', ?)",
            (json.dumps(list(LANGUAGES), ensure_ascii=False),),
        )
        conn.executemany(
            "INSERT INTO concepts(id, pos, meaning, meaning_lang) VALUES(?,?,?,?)",
            concept_rows,
        )
        conn.executemany(
            "INSERT INTO terms(concept_id, lang, text, meaning, rank, readings) VALUES(?,?,?,?,?,?)",
            term_rows,
        )
        conn.commit()
    finally:
        conn.close()
    gz_path = dest.with_suffix(dest.suffix + ".gz") if dest.suffix == ".db" else RUNTIME_DB_GZ
    if dest == RUNTIME_DB:
        gz_path = RUNTIME_DB_GZ
    gz_path.write_bytes(gzip.compress(dest.read_bytes(), compresslevel=9))
    return dest


def sync_frontend(db_path: Path | None = None) -> None:
    source = db_path or RUNTIME_DB
    gz = source.with_name("lexicon-core.db.gz") if source.name != RUNTIME_DB.name else RUNTIME_DB_GZ
    if source == RUNTIME_DB:
        gz = RUNTIME_DB_GZ
    FRONTEND_SEED_GZ.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(gz, FRONTEND_SEED_GZ)
    shutil.copyfile(source, FRONTEND_SEED_DB)
