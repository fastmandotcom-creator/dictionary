from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dict_factory.config import EXPRESSIONS_DIR, SYLLABUS_PATH
from dict_factory.expressions import parse_expression_bundle
from dict_factory.languages import LANGUAGES
from dict_factory.llm import call_chat_json
from dict_factory.syllabus import load_syllabus_jsonl

SYSTEM = """You are a professional multilingual lexicographer for a language-learning engine.
For each concept, write the natural learner EXPRESSION in every requested language.
An expression may be one word or a collocation — use whatever natives actually say.
Never calque English (take medicine is uống thuốc in Vietnamese, not lấy thuốc).
meaning = a short gloss in THAT language, not a repeat of text.
example = one natural sentence in THAT language that uses the expression.
Return ONLY JSON: an array of objects
{"concept_id":"...","langs":{"en":{"text":"...","type":"collocation","meaning":"...","example":"..."}, ...}}
type is one of: word, phrase, collocation, idiom, verb_expression, phrasal_verb, compound_verb, fixed_expression, sentence_pattern.
Every listed language code MUST be present.
"""


def bundle_path(concept_id: str, dest_dir: Path) -> Path:
    return dest_dir / f"{concept_id}.json"


def generate_batch(concepts: list[dict]) -> list[dict]:
    lang_list = ", ".join(LANGUAGES)
    lines = [f"Languages ({len(LANGUAGES)}): {lang_list}", "Concepts:"]
    for concept in concepts:
        lines.append(
            f"- {concept['id']} | {concept['cefr']} | {concept['pos']} | {concept['domain']} | {concept['gloss_en']}"
        )
    payload = call_chat_json(SYSTEM, "\n".join(lines), timeout=180.0)
    if not isinstance(payload, list):
        raise RuntimeError("expression batch must be a JSON array")
    return [parse_expression_bundle(item) for item in payload]


def write_bundle(bundle: dict, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    path = bundle_path(bundle["concept_id"], dest_dir)
    path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def pending_concepts(syllabus: list[dict], dest_dir: Path) -> list[dict]:
    return [concept for concept in syllabus if not bundle_path(concept["id"], dest_dir).exists()]


def generate_expressions(
    *,
    syllabus_path: Path | None = None,
    dest_dir: Path | None = None,
    batch_size: int = 8,
    workers: int = 6,
) -> int:
    syllabus = load_syllabus_jsonl((syllabus_path or SYLLABUS_PATH).read_text(encoding="utf-8"))
    out_dir = dest_dir or EXPRESSIONS_DIR
    todo = pending_concepts(syllabus, out_dir)
    if not todo:
        return 0
    batches = [todo[index : index + batch_size] for index in range(0, len(todo), batch_size)]
    written = 0

    def run(batch: list[dict]) -> list[dict]:
        return generate_batch(batch)

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [pool.submit(run, batch) for batch in batches]
        for future in as_completed(futures):
            for bundle in future.result():
                write_bundle(bundle, out_dir)
                written += 1
            print(f"expressions {written} new this run / {len(todo)} pending")
    return written


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    generate_expressions(batch_size=args.batch_size, workers=args.workers)


if __name__ == "__main__":
    main()
