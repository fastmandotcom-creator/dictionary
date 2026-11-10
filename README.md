# dict factory

LLM-native CONCEPT → EXPRESSION warehouse. Compiles down to the extension `lexicon-core.db` schema.

## Mobile App (Android)

End users download the signed APK from [GitHub Releases](https://github.com/fastmandotcom-creator/dictionary/releases)
(`dict-learn-v1.0.0-android.apk` + `.sha256`). Install on Android 7.0+
("install from unknown sources"; grant Microphone only for pronunciation
checks). Everything is offline: 12k-word dataset, drill / fill-blank /
conjugate modes, IPA + romanization, spaced repetition in IndexedDB.

Rebuild + republish the APK (after data updates):

```bash
python3 -m dict_factory.export_mobile   # out/mobile/www
bash scripts/sync_mobile_data.sh        # -> mobile/www/data
bash scripts/build_release_apk.sh       # -> mobile/android/app/build/.../app-release.apk
bash scripts/package_release_apk.sh     # -> dist/dict-learn-vX.apk + .sha256 + RELEASE_NOTES.md
```

Then attach the three `dist/` files to a GitHub Release (see below).

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

### Advanced mode (listen-and-write drills)

Not just "word = meaning": each concept spawns **advanced drill sentences** the learner
*hears and types back* to practise listening + writing at once.

- **Meaning anchor**: a pack is generated per `(concept, target_lang, topic)` and cached
  in `sentence_drills`. Meaning stays anchored to the concept's `gloss_en`, so all 35
  language surfaces keep one shared meaning and every repeat learner pays **zero** extra
  tokens — the DB fills up organically as people learn.
- **Cache-first, one call per pack**: the LLM is only invoked on a cache miss, and a single
  call fills the whole bounded pack (never per-sentence, never a bulk pass over the 12k
  concepts). `dict_factory/drills.py` → `get_drill_pack()` reads `sentence_drills` first.
- **Bounded drill matrix by part of speech**:
  - verbs / phrases: 3 tenses (present/past/future simple) × 3 polarities
    (affirmative / negative / question) = **9 sentences** per miss;
  - nouns / adjectives / adverbs / other: present × 3 polarities = **3 sentences**.
- **Closed topic presets**: `general`, `business`, `travel`, `daily` — free-form topics
  are intentionally out of scope so the cache key space stays bounded. To add one:
  extend `DRILL_TOPICS` in `dict_factory/drills.py`.

Usage:
```bash
# generate + cache one pack (paid LLM via .env gateway); dry-run only prints the prompt
python -m dict_factory drills --concept EAT_FOOD --topic business
python -m dict_factory drills --concept EAT_FOOD --topic travel --dry-run

# web: topic picker + concept list + hear -> type -> grade flow
GET /listen?base=vi&target=en&topic=business
```
`GET /api/drills` serves a cached pack (503 with a clear detail when the LLM is
unavailable); `POST /api/drills/generate` forces a refresh; `GET /api/drills/topics`
lists the presets. Each drill is its own SRS card
(`{concept}::{tense}/{polarity}`, 1/3/7-day intervals) shared with the regular flashcards.
The optional **"Nâng cao"** segment in `/session` (English target only) weaves a few
listen-write drills into a normal study session and reports "luyện nghe–viết: x/y" in
 the end summary. When the LLM is unreachable the UI falls back to a deterministic
 offline **demo pack** (clearly labelled) so the flow never blocks.

### Standard voices for 35 languages + microphone input

The learner can **hear** a standard neural voice and **dictate** the answer with a
microphone, in any of the 35 product languages.

**TTS ladder** (mirrors the extension architecture — network standard voice first,
browser voice only as the floor):
1. `GET /api/tts?lang=&text=` → server synthesizes with **Microsoft Edge neural
   voices** (`edge-tts`), one cached neural voice per language from the
   35-entry catalog in `dict_factory/tts.py` (ported from the extension's
   `bingTtsVoices` defaults). Repeat plays come from `out/tts_cache.db` + an
   in-memory LRU, so a given `(lang, voice, text)` is synthesized **once**.
2. If the Edge rung fails, the free **Google TTS** rung (`gTTS`) is tried.
3. In the browser, `Srs.speak` plays the server audio and, only if that is
   unavailable, falls back to the **Web Speech** browser voice (shown as
   "giọng trình duyệt"). `Srs.ttsSource()` reports `standard` / `browser` / `none`.

Safety rules: a non-English language **never** resolves to an English voice
(the catalog family-guard rejects it, the API returns 400 so the browser floor
takes over); the documented aliases `no->nb` and `he->iw` are honoured. A voice
for every language is guaranteed by `tests/test_tts.py` (35-language coverage).

**Microphone dictation** (`/asr.js`, served like `srs.js`): a mic button next to the
drill's dictation box (visible only when the browser supports Web Speech). It runs the
extension's `useBrowserSpeechRecognition` behaviour — continuous + interim results,
final transcripts commit into the box for editing **before** grading, language switch
restarted inside `onend` (Chrome race), and clear error messages (mic denied, no
network, no mic). Recognition is 100% client-side: **audio is never uploaded**. The
35 language codes map to their best-coverage BCP-47 tags in `asr.js`.

Dependencies: `edge-tts` + `gTTS` (see `requirements.txt`). With both missing the
ladder degrades to the browser floor automatically — the app still works.

Model default: `ag/gemini-3.7-flash-low` via `LEXICON_LLM_*`.
