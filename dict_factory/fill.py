from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dict_factory.config import EXPRESSIONS_DIR, SYLLABUS_PATH
from dict_factory.extra_data import parse_bilingual_item, parse_phonetics_item
from dict_factory.languages import LANGUAGES
from dict_factory.llm import call_chat_json, llm_config
from dict_factory.prompts import SchemaViolation, estimate_tokens, prompt_messages, validate_payload
from dict_factory.syllabus import load_syllabus_jsonl


def _chunks(items: list, size: int) -> list[list]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _write_record(done_dir: Path, concept_id: str, record: dict) -> None:
    path = done_dir / f"{concept_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _target_surface(concept: dict, target: str) -> str | None:
    """Surface text of a concept in the target language.

    Returns None (never falls back to English) when the bundle entry is
    missing: feeding gloss_en to a target-language prompt silently poisons
    the output with English-flavoured data, so callers must skip and log.
    """
    bundle_path = EXPRESSIONS_DIR / f"{concept['id']}.json"
    if bundle_path.exists():
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        entry = bundle.get("langs", {}).get(target)
        if isinstance(entry, dict):
            text = str(entry.get("text") or "").strip()
            if text:
                return text
    return None


def _split_surface(pending: list[dict], target: str, label: str) -> tuple[list[dict], list[str]]:
    ready = [c for c in pending if _target_surface(c, target) is not None]
    skipped = [c["id"] for c in pending if _target_surface(c, target) is None]
    for cid in skipped:
        print(f"{label}: skip {cid} (no {target} surface text; refusing gloss_en fallback)", flush=True)
    return ready, skipped


def _pending(syllabus: list[dict], done_dir: Path) -> list[dict]:
    return [c for c in syllabus if not (done_dir / f"{c['id']}.json").exists()]


def fill_phonetics(*, target: str, limit: int = 40, dry_run: bool = False, version: str = "v1", batch_size: int = 20, workers: int = 8) -> int:
    if target not in LANGUAGES:
        raise ValueError(f"unknown target lang {target!r}")
    syllabus = load_syllabus_jsonl(SYLLABUS_PATH.read_text(encoding="utf-8"))
    done_dir = EXPRESSIONS_DIR / "phonetics" / target
    pending = _pending(syllabus, done_dir)[:limit]
    if not pending:
        print(f"phonetics [{target}]: nothing pending", flush=True)
        return 0
    ready, skipped = _split_surface(pending, target, "phonetics")
    if not ready:
        print(f"phonetics [{target}]: 0 ready, {len(skipped)} skipped (no surface text)", flush=True)
        return 0
    batches = _chunks(ready, batch_size)
    if dry_run:
        for chunk in batches:
            block = "\n".join(f"- {c['id']} | {c['cefr']} | {_target_surface(c, target)}" for c in chunk)
            variables = {"target_lang": target, "concepts_block": block, "count": len(chunk)}
            messages = prompt_messages("phonetics_text", version=version, variables=variables)
            est = estimate_tokens(messages[0]["content"], messages[1]["content"])
            print(f"phonetics [{target}] dry-run: batch of {len(chunk)}, ~{est} tokens/call, no LLM invoked", flush=True)
        if skipped:
            print(f"phonetics [{target}] dry-run: {len(skipped)} would be skipped (no surface text)", flush=True)
        return 0

    def run_batch(chunk: list[dict]) -> int:
        if not chunk:
            return 0
        block = "\n".join(f"- {c['id']} | {c['cefr']} | {_target_surface(c, target)}" for c in chunk)
        variables = {"target_lang": target, "concepts_block": block, "count": len(chunk)}
        messages = prompt_messages("phonetics_text", version=version, variables=variables)
        try:
            payload = call_chat_json(messages[0]["content"], messages[1]["content"], timeout=180.0)
            if not isinstance(payload, list):
                raise RuntimeError("phonetics batch must be a JSON array")
            validate_payload("phonetics_text", payload)
        except (RuntimeError, SchemaViolation) as exc:
            if len(chunk) > 1:
                print(f"phonetics [{target}]: batch of {len(chunk)} failed ({exc}); splitting", flush=True)
                mid = len(chunk) // 2
                return run_batch(chunk[:mid]) + run_batch(chunk[mid:])
            print(f"phonetics [{target}]: single {chunk[0]['id']} failed ({exc}); kept pending", flush=True)
            return 0
        wanted = {c["id"] for c in chunk}
        written = 0
        for item in payload:
            raw_id = str(item.get("id") or item.get("concept_id") or "").strip()
            if raw_id not in wanted:
                continue
            try:
                parsed = parse_phonetics_item(raw_id, target, item, version)
            except ValueError as exc:
                print(f"phonetics [{target}]: reject {raw_id} ({exc}); kept pending", flush=True)
                continue
            _write_record(done_dir, raw_id, {"concept_id": raw_id, "lang": target, "prompt_v": version, "data": {"ro": parsed["romaji"], "ipa": parsed["ipa"]}})
            written += 1
        return written

    written = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [pool.submit(run_batch, chunk) for chunk in batches]
        for future in as_completed(futures):
            written += future.result()
    print(f"phonetics [{target}]: {written}/{len(ready)} written, {len(skipped)} skipped (no surface text)", flush=True)
    return written


def fill_examples_bilingual(*, target: str, base: str, limit: int = 40, dry_run: bool = False, version: str = "v1", batch_size: int = 20, workers: int = 8) -> int:
    if target not in LANGUAGES or base not in LANGUAGES:
        raise ValueError(f"unknown lang pair target={target!r} base={base!r}")
    if target == base:
        raise ValueError("target and base must differ")
    syllabus = load_syllabus_jsonl(SYLLABUS_PATH.read_text(encoding="utf-8"))
    done_dir = EXPRESSIONS_DIR / "examples_bilingual" / f"{target}-{base}"
    pending = _pending(syllabus, done_dir)[:limit]
    if not pending:
        print(f"examples_bilingual [{target}->{base}]: nothing pending", flush=True)
        return 0
    ready, skipped = _split_surface(pending, target, "examples_bilingual")
    if not ready:
        print(f"examples_bilingual [{target}->{base}]: 0 ready, {len(skipped)} skipped (no surface text)", flush=True)
        return 0
    batches = _chunks(ready, batch_size)
    if dry_run:
        for chunk in batches:
            block = "\n".join(f"- {c['id']} | {c['cefr']} | {_target_surface(c, target)}" for c in chunk)
            variables = {"target_lang": target, "base_lang": base, "concepts_block": block, "count": len(chunk)}
            messages = prompt_messages("examples_bilingual", version=version, variables=variables)
            est = estimate_tokens(messages[0]["content"], messages[1]["content"])
            print(f"examples_bilingual [{target}->{base}] dry-run: batch of {len(chunk)}, ~{est} tokens/call, no LLM invoked", flush=True)
        if skipped:
            print(f"examples_bilingual [{target}->{base}] dry-run: {len(skipped)} would be skipped (no surface text)", flush=True)
        return 0

    def run_batch(chunk: list[dict]) -> int:
        if not chunk:
            return 0
        block = "\n".join(f"- {c['id']} | {c['cefr']} | {_target_surface(c, target)}" for c in chunk)
        variables = {"target_lang": target, "base_lang": base, "concepts_block": block, "count": len(chunk)}
        messages = prompt_messages("examples_bilingual", version=version, variables=variables)
        try:
            payload = call_chat_json(messages[0]["content"], messages[1]["content"], timeout=180.0)
            if not isinstance(payload, list):
                raise RuntimeError("examples_bilingual batch must be a JSON array")
            validate_payload("examples_bilingual", payload)
        except (RuntimeError, SchemaViolation) as exc:
            if len(chunk) > 1:
                print(f"examples_bilingual [{target}->{base}]: batch of {len(chunk)} failed ({exc}); splitting", flush=True)
                mid = len(chunk) // 2
                return run_batch(chunk[:mid]) + run_batch(chunk[mid:])
            print(f"examples_bilingual [{target}->{base}]: single {chunk[0]['id']} failed ({exc}); kept pending", flush=True)
            return 0
        wanted = {c["id"] for c in chunk}
        written = 0
        for item in payload:
            raw_id = str(item.get("id") or item.get("concept_id") or "").strip()
            if raw_id not in wanted:
                continue
            try:
                parsed = parse_bilingual_item(raw_id, target, base, item, version)
            except ValueError as exc:
                print(f"examples_bilingual [{target}->{base}]: reject {raw_id} ({exc}); kept pending", flush=True)
                continue
            _write_record(done_dir, raw_id, {"concept_id": raw_id, "lang_target": target, "lang_base": base, "prompt_v": version, "data": {"st": parsed["sent_target"], "sb": parsed["sent_base"]}})
            written += 1
        return written

    written = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [pool.submit(run_batch, chunk) for chunk in batches]
        for future in as_completed(futures):
            written += future.result()
    print(f"examples_bilingual [{target}->{base}]: {written}/{len(ready)} written, {len(skipped)} skipped (no surface text)", flush=True)
    return written


def fill_units(*, target: str, limit: int = 12, dry_run: bool = False, version: str = "v1") -> int:
    if target not in LANGUAGES:
        raise ValueError(f"unknown target lang {target!r}")
    syllabus = load_syllabus_jsonl(SYLLABUS_PATH.read_text(encoding="utf-8"))
    done_dir = EXPRESSIONS_DIR / "units" / target
    done_units = {p.name for p in done_dir.glob("*.json") if p.is_file()} if done_dir.exists() else set()
    by_cefr: dict[str, list[dict]] = {}
    for concept in syllabus:
        by_cefr.setdefault(concept["cefr"], []).append(concept)
    written = 0
    for cefr in ("A1", "A2", "B1", "B2", "C1"):
        concepts_in_level = by_cefr.get(cefr, [])
        chunks = [concepts_in_level[i : i + 10] for i in range(0, len(concepts_in_level), 10)]
        for index, chunk in enumerate(chunks):
            if written >= limit:
                break
            unit_no = index + 1
            unit_id = f"{cefr}_{unit_no:02d}"
            if unit_id in done_units:
                continue
            block = json.dumps({"order_no": unit_no, "cefr": cefr, "ids": [c["id"] for c in chunk]})
            variables = {"target_lang": target, "units_block": block, "count": 1}
            messages = prompt_messages("units_title", version=version, variables=variables)
            est = estimate_tokens(messages[0]["content"], messages[1]["content"])
            if dry_run:
                print(f"units [{target}] dry-run: {unit_id} ({cefr}, {len(chunk)} concepts), ~{est} tokens, no LLM invoked", flush=True)
                written += 1
                continue
            payload = call_chat_json(messages[0]["content"], messages[1]["content"], timeout=180.0)
            if not isinstance(payload, list) or not payload:
                raise RuntimeError("units batch must be a non-empty JSON array")
            try:
                validate_payload("units_title", payload)
            except SchemaViolation as exc:
                print(f"units [{target}]: {unit_id} schema violation ({exc}); kept pending", flush=True)
                continue
            title = str(payload[0].get("title") or "").strip()
            if not title:
                print(f"units [{target}]: {unit_id} missing title, kept pending", flush=True)
                continue
            record = {
                "unit_id": f"{target}-{cefr}-{unit_no:02d}",
                "order_no": unit_no,
                "cefr": cefr,
                "title": title,
                "ids": [c["id"] for c in chunk],
                "prompt_v": version,
            }
            path = done_dir / f"{unit_id}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            written += 1
    print(f"units [{target}]: {written} written", flush=True)
    return written


def main(args=None) -> None:
    import argparse

    if args is None:
        parser = _build_parser()
        args = parser.parse_args()

    if not args.dry_run and llm_config() is None:
        raise RuntimeError("LLM is not configured (LEXICON_LLM_BASE_URL/API_KEY/MODEL) for a non-dry-run fill.")

    if args.what == "phonetics":
        fill_phonetics(target=args.target, limit=args.limit, dry_run=args.dry_run, version=args.version, batch_size=args.batch_size, workers=args.workers)
    elif args.what == "examples":
        if not args.base:
            raise SystemExit("--base is required for examples")
        fill_examples_bilingual(target=args.target, base=args.base, limit=args.limit, dry_run=args.dry_run, version=args.version, batch_size=args.batch_size, workers=args.workers)
    elif args.what == "units":
        fill_units(target=args.target, limit=args.limit, dry_run=args.dry_run, version=args.version)


def _build_parser():
    import argparse

    parser = argparse.ArgumentParser(prog="dict_factory.fill")
    parser.add_argument("--what", choices=["phonetics", "examples", "units"], required=True)
    parser.add_argument("--target", required=True, help="target language ISO code (e.g. ja)")
    parser.add_argument("--base", default="", help="base (learner) language ISO code; required for examples")
    parser.add_argument("--limit", type=int, default=40, help="max items to fill this run (resume continues after)")
    parser.add_argument("--batch-size", type=int, default=20, help="concepts per LLM call (20-40)")
    parser.add_argument("--workers", type=int, default=8, help="concurrent LLM calls")
    parser.add_argument("--dry-run", action="store_true", help="estimate cost, do not call the LLM")
    parser.add_argument("--version", default="v1", help="prompt version tag recorded into stage files")
    return parser


if __name__ == "__main__":
    main()
