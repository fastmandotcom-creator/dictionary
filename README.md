# dict factory

LLM-native CONCEPT → EXPRESSION warehouse. Compiles down to the extension `lexicon-core.db` schema.

```bash
# Data generation
python -m dict_factory syllabus --target 12000
python -m dict_factory expressions --resume
python -m dict_factory warehouse
python -m dict_factory compile --sync-frontend

# Read-only Web Explorer
python -m dict_factory web --port 8000
```

Model default: `ag/gemini-3.7-flash-low` via `LEXICON_LLM_*`.

