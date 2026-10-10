from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dict_factory.config import EXPRESSIONS_DIR, SYLLABUS_PATH
from dict_factory.extra_data import parse_bilingual_item, parse_monolingual_item, parse_phonetics_item
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


def _mono_surfaces(concept: dict) -> dict[str, str] | None:
    """All 35 surface texts for a concept, or None if the bundle is incomplete.

    No fallback: a monolingual batch must carry every language or the call
    would produce a short (non-35) item the loader must reject anyway.
    """
    bundle_path = EXPRESSIONS_DIR / f"{concept['id']}.json"
    if not bundle_path.exists():
        return None
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    langs = bundle.get("langs") or {}
    surfaces: dict[str, str] = {}
    for lang in LANGUAGES:
        entry = langs.get(lang)
        text = str((entry or {}).get("text") or "").strip() if isinstance(entry, dict) else ""
        if not text:
            return None
        surfaces[lang] = text
    return surfaces


def fill_examples_mono(*, limit: int = 40, dry_run: bool = False, version: str = "v1", batch_size: int = 20, workers: int = 8) -> int:
    """One call writes 35 independent sentences per concept (A1-A2 strategy).

    Output shape per concept: {"id": ..., "s": {lang: sentence}}.
    Sentences are independent per language, NOT translations — display them
    labelled per language, never as translation pairs.
    """
    syllabus = load_syllabus_jsonl(SYLLABUS_PATH.read_text(encoding="utf-8"))
    done_dir = EXPRESSIONS_DIR / "examples_mono"
    pending = _pending(syllabus, done_dir)[:limit]
    if not pending:
        print("examples_mono: nothing pending", flush=True)
        return 0
    ready: list[dict] = []
    skipped: list[str] = []
    surfaces: dict[str, dict[str, str]] = {}
    for concept in pending:
        surf = _mono_surfaces(concept)
        if surf is None:
            skipped.append(concept["id"])
            print(f"examples_mono: skip {concept['id']} (incomplete 35-lang bundle)", flush=True)
        else:
            ready.append(concept)
            surfaces[concept["id"]] = surf
    if not ready:
        print(f"examples_mono: 0 ready, {len(skipped)} skipped (incomplete bundles)", flush=True)
        return 0
    batches = _chunks(ready, batch_size)
    if dry_run:
        for chunk in batches:
            block = "\n".join(
                f"- {c['id']} | {c['cefr']} | " + " || ".join(f"{lang}: {surfaces[c['id']][lang]}" for lang in LANGUAGES)
                for c in chunk
            )
            variables = {"concepts_block": block, "count": len(chunk)}
            messages = prompt_messages("examples_monolingual", version=version, variables=variables)
            est = estimate_tokens(messages[0]["content"], messages[1]["content"])
            print(f"examples_mono dry-run: batch of {len(chunk)} x 35 langs, ~{est} tokens in, no LLM invoked", flush=True)
        return 0

    def run_batch(chunk: list[dict]) -> int:
        if not chunk:
            return 0
        block = "\n".join(
            f"- {c['id']} | {c['cefr']} | " + " || ".join(f"{lang}: {surfaces[c['id']][lang]}" for lang in LANGUAGES)
            for c in chunk
        )
        variables = {"concepts_block": block, "count": len(chunk)}
        messages = prompt_messages("examples_monolingual", version=version, variables=variables)
        try:
            payload = call_chat_json(messages[0]["content"], messages[1]["content"], timeout=180.0)
            if not isinstance(payload, list):
                raise RuntimeError("examples_monolingual batch must be a JSON array")
            validate_payload("examples_monolingual", payload)
        except (RuntimeError, SchemaViolation) as exc:
            if len(chunk) > 1:
                print(f"examples_mono: batch of {len(chunk)} failed ({exc}); splitting", flush=True)
                mid = len(chunk) // 2
                return run_batch(chunk[:mid]) + run_batch(chunk[mid:])
            print(f"examples_mono: single {chunk[0]['id']} failed ({exc}); kept pending", flush=True)
            return 0
        wanted = {c["id"] for c in chunk}
        written = 0
        for item in payload:
            raw_id = str(item.get("id") or item.get("concept_id") or "").strip()
            if raw_id not in wanted:
                continue
            try:
                parsed = parse_monolingual_item(raw_id, item, version)
            except ValueError as exc:
                print(f"examples_mono: reject {raw_id} ({exc}); kept pending", flush=True)
                continue
            _write_record(done_dir, raw_id, {"concept_id": raw_id, "prompt_v": version, "data": {"s": parsed["sentences"]}})
            written += 1
        return written

    written = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = [pool.submit(run_batch, chunk) for chunk in batches]
        for future in as_completed(futures):
            written += future.result()
    print(f"examples_mono: {written}/{len(ready)} written, {len(skipped)} skipped (incomplete bundles)", flush=True)
    return written


def _unit_surface(concept_id: str, target: str) -> str | None:
    """Target-language surface text for unit-titling context (None if missing).

    Unlike phonetics/examples, a missing surface here does not poison anything:
    the title is newly generated from the shared theme, with gloss_en as anchor.
    """
    bundle_path = EXPRESSIONS_DIR / f"{concept_id}.json"
    if not bundle_path.exists():
        return None
    try:
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    entry = (bundle.get("langs") or {}).get(target)
    if not isinstance(entry, dict):
        return None
    return str(entry.get("text") or "").strip() or None


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
            block = json.dumps(
                {
                    "order_no": unit_no,
                    "cefr": cefr,
                    "ids": [c["id"] for c in chunk],
                    "concepts": [
                        {
                            "id": c["id"],
                            "gloss_en": c["gloss_en"],
                            "text": _unit_surface(c["id"], target),
                        }
                        for c in chunk
                    ],
                },
                ensure_ascii=False,
            )
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


def fill_exam_levels(*, frameworks: list[str] | None = None, dry_run: bool = False, version: str = "v1") -> int:
    """Seed one exam framework per LLM call (tiny payloads: 4-9 level rows).

    Resume: frameworks already present in exam_framework are skipped unless
    re-requested explicitly. Validators (schema + 4 table gates) run before
    anything is staged; failures stay pending.
    """
    from dict_factory.db import connect
    from dict_factory.exam_levels import EXAM_FRAMEWORKS, EXAM_SOURCES
    from dict_factory.extra_data import parse_exam_level, validate_exam_table

    wanted = list(frameworks) if frameworks else sorted(EXAM_FRAMEWORKS)
    unknown = [f for f in wanted if f not in EXAM_FRAMEWORKS]
    if unknown:
        raise SystemExit(f"unknown frameworks: {unknown} (known: {sorted(EXAM_FRAMEWORKS)})")
    conn = connect()
    try:
        done = {r[0] for r in conn.execute("SELECT code FROM exam_framework")}
    finally:
        conn.close()
    done_dir = EXPRESSIONS_DIR / "exam_levels"
    written = 0
    for framework in wanted:
        if framework in done and (done_dir / f"{framework}.json").exists():
            print(f"exam-levels [{framework}]: already seeded, skipping", flush=True)
            continue
        spec = EXAM_FRAMEWORKS[framework]
        variables = {
            "framework_code": framework,
            "framework_lang": spec["lang"],
            "framework_name": spec["name"],
            "source_tag": spec["source"],
            "level_codes": ", ".join(spec["levels"]),
            "mapping_table": spec["mapping_table"],
            "count": len(spec["levels"]),
        }
        messages = prompt_messages("exam_levels", version=version, variables=variables)
        if dry_run:
            est = estimate_tokens(messages[0]["content"], messages[1]["content"])
            print(f"exam-levels [{framework}] dry-run: {len(spec['levels'])} levels, ~{est} tokens in, no LLM invoked", flush=True)
            continue
        try:
            payload = call_chat_json(messages[0]["content"], messages[1]["content"], timeout=180.0)
            if not isinstance(payload, list):
                raise RuntimeError("exam_levels batch must be a JSON array")
            validate_payload("exam_levels", payload)
            rows = [parse_exam_level(framework, spec["levels"], EXAM_SOURCES, item, version) for item in payload]
            if {r["code"] for r in rows} != set(spec["levels"]):
                raise ValueError(f"{framework}: must emit exactly the closed enum")
            validate_exam_table(framework, rows)
        except (RuntimeError, SchemaViolation, ValueError) as exc:
            print(f"exam-levels [{framework}] failed ({exc}); kept pending", flush=True)
            continue
        done_dir.mkdir(parents=True, exist_ok=True)
        (done_dir / f"{framework}.json").write_text(
            json.dumps(
                {"framework": framework, "lang": spec["lang"], "name": spec["name"], "prompt_v": version, "data": payload},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        written += 1
    print(f"exam-levels: {written}/{len(wanted)} frameworks staged", flush=True)
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
    elif args.what == "examples-mono":
        fill_examples_mono(limit=args.limit, dry_run=args.dry_run, version=args.version, batch_size=args.batch_size, workers=args.workers)
    elif args.what == "units":
        fill_units(target=args.target, limit=args.limit, dry_run=args.dry_run, version=args.version)
    elif args.what == "exam-levels":
        wanted = None if args.framework in ("", "all") else [args.framework]
        fill_exam_levels(frameworks=wanted, dry_run=args.dry_run, version=args.version)


def _build_parser():
    import argparse

    parser = argparse.ArgumentParser(prog="dict_factory.fill")
    parser.add_argument("--what", choices=["phonetics", "examples", "examples-mono", "units", "exam-levels"], required=True)
    parser.add_argument("--framework", default="all", help="exam framework code for exam-levels (or 'all')")
    parser.add_argument("--target", default="ja", help="target language ISO code (not needed for examples-mono)")
    parser.add_argument("--base", default="", help="base (learner) language ISO code; required for examples")
    parser.add_argument("--limit", type=int, default=40, help="max items to fill this run (resume continues after)")
    parser.add_argument("--batch-size", type=int, default=20, help="concepts per LLM call (20-40)")
    parser.add_argument("--workers", type=int, default=8, help="concurrent LLM calls")
    parser.add_argument("--dry-run", action="store_true", help="estimate cost, do not call the LLM")
    parser.add_argument("--version", default="v1", help="prompt version tag recorded into stage files")
    return parser


if __name__ == "__main__":
    main()
