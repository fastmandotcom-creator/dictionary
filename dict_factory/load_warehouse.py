from __future__ import annotations

import argparse
import json
from pathlib import Path

from dict_factory.config import EXPRESSIONS_DIR, SYLLABUS_PATH, WAREHOUSE_DB
from dict_factory.db import connect, init_schema
from dict_factory.expressions import parse_expression_bundle
from dict_factory.languages import LANGUAGES
from dict_factory.syllabus import load_syllabus_jsonl


def load_bundles(expressions_dir: Path | None = None) -> dict[str, dict]:
    bundles: dict[str, dict] = {}
    for path in sorted((expressions_dir or EXPRESSIONS_DIR).glob("*.json")):
        bundle = parse_expression_bundle(json.loads(path.read_text(encoding="utf-8")))
        bundles[bundle["concept_id"]] = bundle
    return bundles


def load_warehouse(
    *,
    syllabus_path: Path | None = None,
    expressions_dir: Path | None = None,
    dest: Path | None = None,
) -> Path:
    concepts = load_syllabus_jsonl((syllabus_path or SYLLABUS_PATH).read_text(encoding="utf-8"))
    bundles = load_bundles(expressions_dir or EXPRESSIONS_DIR)
    missing = [concept["id"] for concept in concepts if concept["id"] not in bundles]
    if missing:
        raise ValueError(f"missing {len(missing)} expression bundles, e.g. {missing[:5]}")
    db_path = dest or WAREHOUSE_DB
    if db_path.exists():
        db_path.unlink()
    conn = connect(db_path)
    try:
        init_schema(conn)
        conn.executemany(
            "INSERT INTO concepts(id, domain, cefr, pos, gloss_en, rank) VALUES(?,?,?,?,?,?)",
            [
                (
                    concept["id"],
                    concept["domain"],
                    concept["cefr"],
                    concept["pos"],
                    concept["gloss_en"],
                    concept["rank"],
                )
                for concept in concepts
            ],
        )
        expression_rows = []
        example_rows = []
        for concept in concepts:
            bundle = bundles[concept["id"]]
            for lang in LANGUAGES:
                entry = bundle["langs"][lang]
                expression_rows.append(
                    (concept["id"], lang, entry["text"], entry["type"], entry["meaning"])
                )
                example_rows.append((concept["id"], lang, entry["example"]))
        conn.executemany(
            "INSERT INTO expressions(concept_id, lang, text, expression_type, meaning) VALUES(?,?,?,?,?)",
            expression_rows,
        )
        conn.executemany(
            "INSERT INTO examples(concept_id, lang, sentence) VALUES(?,?,?)",
            example_rows,
        )
        conn.commit()
    finally:
        conn.close()
    return db_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dest", type=Path, default=None)
    args = parser.parse_args()
    path = load_warehouse(dest=args.dest)
    print(f"warehouse {path}")


if __name__ == "__main__":
    main()
