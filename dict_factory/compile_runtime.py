from __future__ import annotations

import gzip
import json
import shutil
import sqlite3
from pathlib import Path

from dict_factory.config import FRONTEND_SEED_DB, FRONTEND_SEED_GZ, RUNTIME_DB, RUNTIME_DB_GZ
from dict_factory.expressions import ExpressionError, parse_expression_bundle, runtime_pos
from dict_factory.languages import LANGUAGES

# v3: + concepts.cefr/domain, + examples, + exam_framework/exam_level.
# Additive only: existing v2 extension code that reads concepts/terms still works.
CORE_SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE concepts (
  id TEXT PRIMARY KEY,
  pos TEXT NOT NULL,
  meaning TEXT NOT NULL,
  meaning_lang TEXT NOT NULL DEFAULT 'en',
  cefr TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT ''
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
CREATE TABLE examples (
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  lang TEXT NOT NULL,
  sentence TEXT NOT NULL,
  UNIQUE (concept_id, lang)
);
CREATE INDEX idx_examples_concept ON examples(concept_id);
CREATE TABLE exam_framework (
  code TEXT PRIMARY KEY,
  lang TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE exam_level (
  framework TEXT NOT NULL REFERENCES exam_framework(code),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  cefr_lo TEXT NOT NULL,
  cefr_hi TEXT NOT NULL,
  sort_no INTEGER NOT NULL,
  PRIMARY KEY (framework, code)
);
CREATE INDEX idx_exam_level_framework ON exam_level(framework, sort_no);
"""


def load_examples_for_runtime(conn: sqlite3.Connection) -> list[tuple[str, str, str]]:
    """(concept_id, lang, sentence) rows from the warehouse, for runtime examples."""
    rows = conn.execute("SELECT concept_id, lang, sentence FROM examples WHERE TRIM(sentence) != ''").fetchall()
    return [(r["concept_id"], r["lang"], r["sentence"]) for r in rows]


def load_exam_for_runtime(conn: sqlite3.Connection) -> tuple[list[tuple], list[tuple]]:
    """(frameworks, levels) rows from the warehouse, for runtime exam tables."""
    frameworks = conn.execute("SELECT code, lang, name, version FROM exam_framework ORDER BY code").fetchall()
    levels = conn.execute(
        "SELECT framework, code, label, cefr_lo, cefr_hi, sort_no FROM exam_level ORDER BY framework, sort_no"
    ).fetchall()
    return (
        [(f["code"], f["lang"], f["name"], f["version"]) for f in frameworks],
        [(l["framework"], l["code"], l["label"], l["cefr_lo"], l["cefr_hi"], l["sort_no"]) for l in levels],
    )


def compile_runtime(
    concepts: list[dict],
    bundles: dict[str, dict],
    dest: Path | None = None,
    phonetics: dict[tuple[str, str], str] | None = None,
    examples: list[tuple[str, str, str]] | None = None,
    exam: tuple[list[tuple], list[tuple]] | None = None,
) -> Path:
    """Compile the runtime extension DB.

    `phonetics` maps (concept_id, lang) -> romaji and fills `terms.readings`;
    pass None/{} to leave readings NULL (nothing filled yet).
    `examples` is a list of (concept_id, lang, sentence) for the examples table.
    `exam` is (framework_rows, level_rows) for the exam tables; pass a single
    list to treat it as level rows only. All optional — v2 callers still work.
    """
    dest = dest or RUNTIME_DB
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    readings = phonetics or {}
    example_rows = [r for r in (examples or []) if r[0] in {c["id"] for c in concepts}]
    exam_rows: list[tuple]
    exam_levels: list[tuple]
    if exam is None:
        exam_rows, exam_levels = [], []
    elif isinstance(exam, tuple) and len(exam) == 2 and isinstance(exam[0], list):
        exam_rows, exam_levels = exam
    else:
        exam_rows, exam_levels = [], exam
    conn = sqlite3.connect(dest)
    try:
        conn.executescript(CORE_SCHEMA)
        concept_rows: list[tuple[str, str, str, str, str, str]] = []
        term_rows: list[tuple[str, str, str, str, int, str | None]] = []
        for concept in sorted(concepts, key=lambda item: item["rank"]):
            raw_bundle = bundles.get(concept["id"])
            if raw_bundle is None:
                raise ValueError(f"missing expressions for {concept['id']}")
            try:
                bundle = parse_expression_bundle(raw_bundle)
            except ExpressionError as exc:
                raise ValueError(f"invalid expressions for {concept['id']}: {exc}") from exc
            en_entry = bundle["langs"].get("en")
            if en_entry is None:
                raise ValueError(f"missing English expression for {concept['id']}")
            pos = runtime_pos(concept["pos"], en_entry["type"])
            concept_rows.append(
                (
                    concept["id"],
                    pos,
                    concept["gloss_en"],
                    "en",
                    str(concept.get("cefr", "")),
                    str(concept.get("domain", "")),
                )
            )
            for lang in LANGUAGES:
                entry = bundle["langs"].get(lang)
                if entry is None:
                    raise ValueError(f"missing {lang} expression for {concept['id']}")
                term_rows.append(
                    (
                        concept["id"],
                        lang,
                        entry["text"],
                        entry["meaning"],
                        int(concept["rank"]),
                        readings.get((concept["id"], lang)),
                    )
                )
        conn.execute("INSERT INTO meta(key, value) VALUES('version', '3')")
        conn.execute("INSERT INTO meta(key, value) VALUES('count', ?)", (str(len(concept_rows)),))
        conn.execute("INSERT INTO meta(key, value) VALUES('topN', ?)", (str(len(concept_rows)),))
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('languages', ?)",
            (json.dumps(list(LANGUAGES), ensure_ascii=False),),
        )
        conn.executemany(
            "INSERT INTO concepts(id, pos, meaning, meaning_lang, cefr, domain) VALUES(?,?,?,?,?,?)",
            concept_rows,
        )
        conn.executemany(
            "INSERT INTO terms(concept_id, lang, text, meaning, rank, readings) VALUES(?,?,?,?,?,?)",
            term_rows,
        )
        if example_rows:
            conn.executemany("INSERT OR REPLACE INTO examples(concept_id, lang, sentence) VALUES(?,?,?)", example_rows)
        for f in exam_rows:
            conn.execute(
                "INSERT OR REPLACE INTO exam_framework(code, lang, name, version) VALUES(?,?,?,?)",
                f,
            )
        for l in exam_levels:
            conn.execute(
                "INSERT OR REPLACE INTO exam_level(framework, code, label, cefr_lo, cefr_hi, sort_no) VALUES(?,?,?,?,?,?)",
                l,
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
