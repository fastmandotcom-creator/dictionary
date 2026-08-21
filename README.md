# dict factory

LLM-native CONCEPT → EXPRESSION warehouse. Compiles down to the extension `lexicon-core.db` schema.

```bash
python -m dict_factory syllabus --target 12000
python -m dict_factory expressions --resume
python -m dict_factory warehouse
python -m dict_factory compile --sync-frontend
```

Model default: `ag/gemini-3.7-flash-low` via `LEXICON_LLM_*`.
