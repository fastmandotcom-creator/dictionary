# Migrating to a new machine

This repo is **self-contained**: it carries the code, the learning data
(`data/`), and (intentionally) the LLM credentials (`secrets/llm.env`), so a
clone reproduces a 100%-working project.

## Steps on the new machine

```bash
git clone git@github.com:fastmandotcom-creator/dictionary.git
cd dictionary
python3 bootstrap.py        # restores out/ (DBs) + .env from the committed bundle
python3 -m dict_factory web # serve the learning app on http://127.0.0.1:8000
```

`bootstrap.py` is idempotent — run it again anytime; it never overwrites an
existing `out/` DB or `.env`.

## What is bundled where

| Path | Contents |
| --- | --- |
| `data/warehouse.db.gz` | the learning-app DB (concepts, expressions, examples, exam tables) |
| `data/lexicon-core.db.gz` | compiled extension seed DB (+ .gz) |
| `data/progress.db.gz` | device-synced learning progress |
| `data/syllabus.jsonl` | 12k-concept syllabus (pipeline input) |
| `data/expressions.tar.gz` | 420k expression bundles (pipeline input) |
| `secrets/llm.env` | **live** LLM gateway credentials (tracked on purpose) |

## ⚠️ Security note — read this

`secrets/llm.env` contains a **live API key** for the LLM gateway. It is
tracked in this **private** repo so migration is one `git clone`.

- If this repo ever becomes public, or you share it with anyone, **rotate the
  key first** and remove `secrets/llm.env` from history
  (`git filter-repo` / BFG) — deleting it in a new commit is not enough.
- The key targets `LEXICON_LLM_BASE_URL=http://localhost:20128/v1`, a
  **local** gateway. On the new machine the LLM *data-generation* pipeline
  (`dict_factory syllabus/expressions/fill`) only works if that gateway is
  also running there. The learning app (`dict_factory web`) needs no key at
  all.

## Slimming the repo later (optional)

`data/` adds ~90MB to every clone. Once the new machine is set up and you no
 longer need single-clone portability, you can stop carrying it:
`git rm -r data secrets` in a follow-up commit (the files stay in history but
are dropped from future checkouts).
