from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from dict_factory.config import EXPRESSIONS_DIR, SYLLABUS_PATH
from dict_factory.expressions import parse_expression_bundle
from dict_factory.languages import LANGUAGES, language_prompt_block
from dict_factory.llm import call_chat_json
from dict_factory.prompts import prompt_messages
from dict_factory.syllabus import load_syllabus_jsonl


def bundle_path(concept_id: str, dest_dir: Path) -> Path:
    return dest_dir / f"{concept_id}.json"


def generate_batch(concepts: list[dict]) -> list[dict]:
    if not concepts:
        return []
    if len(concepts) == 1:
        return _generate_one_batch(concepts)
    try:
        return _generate_one_batch(concepts)
    except Exception as exc:
        print(f"batch of {len(concepts)} failed ({exc}); splitting", flush=True)
        mid = len(concepts) // 2
        return generate_batch(concepts[:mid]) + generate_batch(concepts[mid:])


def _generate_one_batch(concepts: list[dict]) -> list[dict]:
    block = "\n".join(
        f"- {concept['id']} | {concept['cefr']} | {concept['pos']} | {concept['domain']} | {concept['gloss_en']}"
        for concept in concepts
    )
    messages = prompt_messages(
        "expressions",
        variables={
            "target_langs": language_prompt_block(),
            "concepts_block": block,
            "count": len(concepts),
        },
    )
    payload = call_chat_json(messages[0]["content"], messages[1]["content"], timeout=180.0)
    if not isinstance(payload, list):
        raise RuntimeError("expression batch must be a JSON array")
    bundles = []
    for item in payload:
        try:
            bundles.append(parse_expression_bundle(item))
        except Exception:
            continue
    wanted = {concept["id"] for concept in concepts}
    return [bundle for bundle in bundles if bundle["concept_id"] in wanted]


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
    batch_size: int = 20,
    workers: int = 8,
) -> int:
    syllabus = load_syllabus_jsonl((syllabus_path or SYLLABUS_PATH).read_text(encoding="utf-8"))
    out_dir = dest_dir or EXPRESSIONS_DIR
    todo = pending_concepts(syllabus, out_dir)
    if not todo:
        return 0
    batches = [todo[index : index + batch_size] for index in range(0, len(todo), batch_size)]
    written = 0

    def run(batch: list[dict]) -> list[dict]:
        try:
            return generate_batch(batch)
        except Exception as exc:
            print(f"batch dropped after retries: {exc}", flush=True)
            return []

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [pool.submit(run, batch) for batch in batches]
        for future in as_completed(futures):
            for bundle in future.result():
                write_bundle(bundle, out_dir)
                written += 1
            done = len(todo) - len(pending_concepts(syllabus, out_dir))
            print(f"expressions {done}/{len(syllabus)} total", flush=True)
    leftover = pending_concepts(syllabus, out_dir)
    if leftover:
        print(f"expressions leftover {len(leftover)} — rerun to resume", flush=True)
    return written


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    generate_expressions(batch_size=args.batch_size, workers=args.workers)


if __name__ == "__main__":
    main()
