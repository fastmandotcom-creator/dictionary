# dict factory

LLM-native CONCEPT → EXPRESSION warehouse. Compiles down to the extension `lexicon-core.db` schema.

## Pipeline (data plane)

```bash
# Core lexicon
python -m dict_factory syllabus --target 12000   # out/syllabus.jsonl
python -m dict_factory expressions --resume      # out/expressions/<CONCEPT>.json (35 langs)
python -m dict_factory warehouse                 # out/warehouse.db
python -m dict_factory compile --sync-frontend    # out/lexicon-core.db(.gz)

# Learn-data plane (text-only MVP, framework + prompts; plug LLM API to fill)
python -m dict_factory fill --what phonetics  --target ja --limit 40 --dry-run
python -m dict_factory fill --what examples   --target ja --base vi --limit 40 --batch-size 20 --workers 8
python -m dict_factory fill --what units      --target ja --limit 12
python -m dict_factory extra                 # stage JSONs -> warehouse.db extra tables

# Read-only Web Explorer
python -m dict_factory web --port 8000
```

## Architecture

Two SQLite stores:

1. `out/warehouse.db` — full pedagogical warehouse (concepts / expressions / examples + extra
   learn tables `phonetics_text`, `examples_bilingual`, `units`, `unit_items`).
2. `out/lexicon-core.db` — runtime extension schema (`meta`, `concepts`, `terms`), gzip-synced to the frontend.

Learn data is **per-language**, not per-language-pair. A cross-lingual view (`base -> target`)
is a JOIN of two `terms`/`expressions` rows on `concept_id`; only the small per-pair extras
(bilingual examples, unit titles) are stored, so there is no 1190-pair matrix.

### Prompt standard (`dict_factory/prompts/`)

Every LLM call is a `SYSTEM.md` + `USER.md` template + a JSON Schema (`*.schema.json`) registered
in `dict_factory/prompts.py`. The user template is rendered with `.format(**variables)` and must
never hardcode a concrete language pair — it only carries `target_lang` / `base_lang` codes.

- `temperature=0.2`, `timeout=180s`, `retries=3` with jittered backoff (in `llm.py`).
- `--dry-run` estimates tokens before any LLM call; `--limit` + stage files make every fill
  resumable. Bump `--version v1 -> v2` and re-check the golden set in `tests/test_golden_set.py`.

### Web learn flow (text-only MVP)

- `GET /onboarding` — pick `base` + `target` + start CEFR.
- `GET /learn?base=&target=&cefr=` — units; falls back to a synthesized cefr/domain unit list when no units are filled yet.
- `GET /learn/{concept}?base=&target=` — hero card: `text_target` + romaji/IPA (if filled) + `text_base` + bilingual example + 3 grading buttons (localStorage).
- `GET /review?base=&target=&cefr=` — flashcards (localStorage progress).
- `GET /api/learn/{concept}?base=&target=` — JSON of the same card.

All routes are generic over the 35 ISO 639-1 codes; nothing is hardcoded to `vi->ja`.

Model default: `ag/gemini-3.7-flash-low` via `LEXICON_LLM_*`.
