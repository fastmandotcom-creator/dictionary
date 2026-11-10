from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from dict_factory.config import OUT_DIR, WAREHOUSE_DB
from dict_factory.languages import LANGUAGE_SPECS

DATA_DIR = OUT_DIR / "mobile" / "www"


def _load(src: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def export_pack(src: Path | None = None, dest: Path | None = None) -> Path:
    source = src or WAREHOUSE_DB
    target = dest or DATA_DIR
    if target.exists():
        for path in target.rglob("*"):
            if path.is_file():
                path.unlink()
    lang_dir = target / "lang"
    lang_dir.mkdir(parents=True, exist_ok=True)
    conn = _load(source)
    try:
        concepts = [
            row["id"]
            for row in conn.execute(
                "SELECT id FROM concepts ORDER BY CASE cefr WHEN 'A1' THEN 1 WHEN 'A2' THEN 2 "
                "WHEN 'B1' THEN 3 WHEN 'B2' THEN 4 ELSE 5 END, rank"
            )
        ]
        (target / "concepts.json").write_text(json.dumps(concepts, ensure_ascii=False), encoding="utf-8")
        (target / "langs.json").write_text(
            json.dumps(
                [{"code": code, "native": native} for code, _name, native, _tag in LANGUAGE_SPECS],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        has_aligned = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='aligned_examples'"
        ).fetchone()
        has_drills = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sentence_drills'"
        ).fetchone()
        has_phonetics = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='phonetics_text'"
        ).fetchone()
        for code, _name, _native, _tag in LANGUAGE_SPECS:
            words = {
                row["concept_id"]: row["text"]
                for row in conn.execute("SELECT concept_id, text FROM expressions WHERE lang=?", (code,))
            }
            examples = {}
            if has_aligned:
                examples = {
                    row["concept_id"]: row["sentence"]
                    for row in conn.execute(
                        "SELECT concept_id, sentence FROM aligned_examples WHERE lang=?",
                        (code,),
                    )
                }
            # M2.2: romanization + IPA per language (filled by offline_fill phonetics).
            # Keys are always present so old clients keep working; empty until data lands.
            romaji = {}
            ipa = {}
            if has_phonetics:
                for row in conn.execute(
                    """
                    SELECT concept_id, romaji, ipa FROM phonetics_text
                    WHERE lang = ? AND romaji IS NOT NULL AND ipa IS NOT NULL
                    """,
                    (code,),
                ):
                    romaji[row["concept_id"]] = row["romaji"]
                    ipa[row["concept_id"]] = row["ipa"]
            (lang_dir / f"{code}.json").write_text(
                json.dumps({"w": words, "e": examples, "ro": romaji, "ipa": ipa}, ensure_ascii=False),
                encoding="utf-8",
            )
        drills = {}
        if has_drills:
            # M2.3: include tense + polarity so the app can build a conjugate
            # (pick-the-correct-form) mode with real distractors, not just
            # a flat listen-and-write list.
            for row in conn.execute(
                """
                SELECT concept_id, sentence, COALESCE(base_hint, '') AS hint,
                       tense, polarity, surface
                FROM sentence_drills
                WHERE topic='business' AND target_lang='en'
                ORDER BY concept_id, drill_key
                """
            ):
                drills.setdefault(row["concept_id"], []).append(
                    {"s": row["sentence"], "h": row["hint"],
                     "t": row["tense"], "p": row["polarity"],
                     "sf": row["surface"]}
                )
        (target / "drills.json").write_text(json.dumps(drills, ensure_ascii=False), encoding="utf-8")
    finally:
        conn.close()
    return target


def main() -> None:
    path = export_pack()
    print(f"pack {path}")


if __name__ == "__main__":
    main()
