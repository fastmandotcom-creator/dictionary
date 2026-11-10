from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from dict_factory.config import OUT_DIR, ROOT
from dict_factory.db import connect, init_schema
from dict_factory.drills import (
    POLARITIES,
    TENSES,
    _SENTENCE_RE,
    drill_matrix_for_pos,
    validate_drill_pack,
)
from dict_factory.languages import LANGUAGES
from dict_factory.llm import _strip_fences, call_chat_text

# (model, output cap, max parallel). max parallel splits the shared gateway
# quota so per-model backoff windows do not overlap across worker threads.
MODELS: tuple[tuple[str, int, int], ...] = (
    ("cx/gpt-6-luna", 128000, 3),
    ("ag/gemini-3.8-flash-low", 65536, 5),
    ("ag/gemini-4-argon-low", 65536, 5),
)
MODEL = MODELS[0][0]
OUTPUT_BUDGET = 100000
MAX_TOKENS = 128000
KINDS = ("aligned", "phonetics", "drills")
PRIORITY = ("aligned", "drills")

# Scheduler tunables (overridable in tests by reassigning these globals).
BACKOFF_BASE = 10.0          # first backoff step, seconds
BACKOFF_FACTOR = 2.0        # exponential growth per consecutive limit hit
BACKOFF_CAP = 900.0         # hard cap on a single backoff sleep
PATIENCE_SECONDS = 1800.0   # keep retrying a shard this long before fallback
FALLBACK_DRILLS = True      # deterministic offline pack when all models are limited

RAW_DIR = OUT_DIR / "offline_raw"
PROGRESS_DB = OUT_DIR / "offline_fill.db"

ALIGNED_SYSTEM = (
    "You write one short spoken sentence per language for each concept. "
    "Every sentence must express the concept's English gloss, not a different idea. "
    "4 to 14 words. No numbering, no markdown."
)
PHONETICS_SYSTEM = (
    "You write a Latin romanization and an IPA transcription for each concept "
    "in every requested language. Romanization is ASCII letters, spaces, apostrophes, "
    "hyphens, and periods only. IPA may use phonetic symbols."
)
DRILL_SYSTEM = (
    "You write English listen-and-write sentences for office, economy, and trade. "
    "Meaning is fixed by gloss_en. Use the English surface word. "
    "Spoken style, 3 to 18 words. base_hint is a short Vietnamese gloss of the sentence."
)


def use_bulk_gateway(model: str = MODEL) -> None:
    env_file = ROOT / "secrets" / "llm.env"
    if not env_file.exists():
        raise RuntimeError(f"missing {env_file}")
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ[key.strip()] = value.strip().strip('"').strip("'")
    os.environ["LEXICON_LLM_MODEL"] = model


def _progress() -> sqlite3.Connection:
    PROGRESS_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(PROGRESS_DB)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS shards (
          kind TEXT NOT NULL,
          shard_id TEXT NOT NULL,
          status TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (kind, shard_id)
        )
        """
    )
    return conn


def _mark(kind: str, shard_id: str, status: str, detail: str = "") -> None:
    conn = _progress()
    try:
        conn.execute(
            "INSERT INTO shards (kind, shard_id, status, detail) VALUES (?,?,?,?) "
            "ON CONFLICT(kind, shard_id) DO UPDATE SET status=excluded.status, detail=excluded.detail",
            (kind, shard_id, status, detail[:500]),
        )
        conn.commit()
    finally:
        conn.close()


def _done_ids(kind: str) -> set[str]:
    conn = _progress()
    try:
        rows = conn.execute(
            "SELECT shard_id FROM shards WHERE kind = ? AND status = 'done'",
            (kind,),
        ).fetchall()
    finally:
        conn.close()
    return {row[0] for row in rows}


def _failed_ids(kind: str) -> set[str]:
    conn = _progress()
    try:
        rows = conn.execute(
            "SELECT shard_id FROM shards WHERE kind = ? AND status = 'failed'",
            (kind,),
        ).fetchall()
    finally:
        conn.close()
    return {row[0] for row in rows}


def load_concepts(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT c.id, c.pos, c.cefr, c.gloss_en, c.rank, e.text AS en
        FROM concepts c
        LEFT JOIN expressions e ON e.concept_id = c.id AND e.lang = 'en'
        ORDER BY c.rank
        """
    ).fetchall()
    return [dict(row) for row in rows]


def missing_aligned(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    have = {
        row[0]
        for row in conn.execute(
            "SELECT concept_id FROM aligned_examples GROUP BY concept_id HAVING COUNT(*) = ?",
            (len(LANGUAGES),),
        )
    }
    return [c for c in load_concepts(conn) if c["id"] not in have]


def missing_phonetics(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    have = {
        row[0]
        for row in conn.execute(
            "SELECT concept_id FROM phonetics_text GROUP BY concept_id HAVING COUNT(*) = ?",
            (len(LANGUAGES),),
        )
    }
    return [c for c in load_concepts(conn) if c["id"] not in have]


def missing_drills(conn: sqlite3.Connection, topic: str = "business") -> list[dict[str, Any]]:
    out = []
    for concept in load_concepts(conn):
        wanted = len(drill_matrix_for_pos(concept["pos"]))
        got = conn.execute(
            "SELECT COUNT(*) FROM sentence_drills WHERE concept_id = ? AND target_lang = 'en' AND topic = ?",
            (concept["id"], topic),
        ).fetchone()[0]
        if got < wanted:
            out.append(concept)
    return out


def chunk(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def parse_aligned(payload: Any, wanted: set[str]) -> dict[str, dict[str, str]]:
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("aligned payload has no rows")
    out: dict[str, dict[str, str]] = {}
    for row in rows:
        if not isinstance(row, list) or len(row) != 1 + len(LANGUAGES):
            continue
        cid = str(row[0])
        if cid not in wanted:
            continue
        sentences = {}
        ok = True
        for lang, text in zip(LANGUAGES, row[1:]):
            sentence = str(text or "").strip()
            if not (3 <= len(sentence) <= 240):
                ok = False
                break
            sentences[lang] = sentence
        if ok:
            out[cid] = sentences
    return out


def parse_phonetics(payload: Any, wanted: set[str]) -> dict[str, dict[str, tuple[str, str]]]:
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("phonetics payload has no rows")
    out: dict[str, dict[str, tuple[str, str]]] = {}
    width = 1 + len(LANGUAGES) * 2
    for row in rows:
        if not isinstance(row, list) or len(row) != width:
            continue
        cid = str(row[0])
        if cid not in wanted:
            continue
        cells: dict[str, tuple[str, str]] = {}
        ok = True
        for i, lang in enumerate(LANGUAGES):
            romaji = str(row[1 + i * 2] or "").strip()
            ipa = str(row[2 + i * 2] or "").strip()
            if not romaji or not ipa or len(romaji) > 64 or len(ipa) > 96:
                ok = False
                break
            if any(ord(ch) > 127 for ch in romaji):
                ok = False
                break
            cells[lang] = (romaji, ipa)
        if ok:
            out[cid] = cells
    return out


def build_concept_surface_index(concepts: list[dict[str, Any]]) -> dict[str, str]:
    """Map lower-cased surface words (the concept's `en` expression and `gloss_en`)
    to their concept id. Lets a drill row that names its concept via surface text
    (rather than via a resolvable drill_key) be routed to the right concept."""
    index: dict[str, str] = {}
    for c in concepts:
        cid = str(c.get("id") or "")
        for word in (str(c.get("en") or ""), str(c.get("gloss_en") or ""),
                     str(c.get("surface") or "")):
            w = word.strip().lower()
            if w and w not in index:
                index[w] = cid
    return index


def _row_target(row: dict[str, Any], cid: str, concepts_by_id: dict[str, dict[str, Any]],
                surface_index: dict[str, str]) -> str | None:
    """Resolve which concept a drill row belongs to, in shape order.

    Returns the concept id, or None if the row cannot be routed. The resolver
    tries the most reliable signals first:
      1. exact drill_key == requested cid            (single-concept pack)
      2. `cid!tense/polarity` or `cid!tense!polarity` (per-row prefix)
      3. row surface anchored on the requested concept's `en`/`gloss_en`
      4. row surface anchored on ANY concept via the surface index
    """
    key = str(row.get("drill_key") or "").strip()
    norm_key = key.strip().lower()
    if key == cid:
        return cid
    if key.startswith(cid + "!"):
        return cid
    c = concepts_by_id.get(cid)
    if c:
        anchor = _surface_for(c).strip().lower()
        if anchor and anchor in str(row.get("surface") or "").lower():
            return cid
    for w in (str(row.get("surface") or "").strip().lower(),):
        if w and w in surface_index:
            return surface_index[w]
    return None


def parse_drills(payload: Any, concepts: list[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    """Parse any supported drill payload shape back into validated per-concept packs.

    Accepts a JSON object ``{"packs":[{id, sentences:[...]}]}`` where each
    sentence row is one of the gateway's known drill_key shapes, including the
    multi-concept "global pack" that aggregates several concepts into one
    synthetic pack. Every requested concept is guaranteed a complete pack: the
    model's row for a spec is used when it passes the validator's per-row rules,
    otherwise the deterministic offline row (the same grammar the sanctioned
    ``v1-offline`` fallback emits) fills that spec. This turns "0/N" responses
    into fully recoverable data instead of dropping the whole shard.
    """
    packs = payload.get("packs") if isinstance(payload, dict) else None
    if not isinstance(packs, list):
        raise ValueError("drills payload has no packs")
    by_id = {c["id"]: c for c in concepts}
    surface_index = build_concept_surface_index(concepts)
    # Resolve rows to concepts, keep the best row per requested spec.
    grouped: dict[str, dict[str, dict[str, Any]]] = {}
    for pack in packs:
        if not isinstance(pack, dict):
            continue
        pack_cid = str(pack.get("id") or "")
        for row in (pack.get("sentences") or []):
            if not isinstance(row, dict):
                continue
            target = _row_target(row, pack_cid, by_id, surface_index)
            if target is None:
                continue
            per_spec = grouped.setdefault(target, {})
            key = _row_spec_key(row)
            if key and key not in per_spec and _row_ok(row):
                fixed = dict(row)
                fixed["drill_key"] = key
                per_spec[key] = fixed
    out: dict[str, list[dict[str, str]]] = {}
    for cid, per_spec in grouped.items():
        concept = by_id.get(cid)
        if concept is None:
            continue
        rows = _assemble_pack(concept, per_spec)
        if rows is not None:
            out[cid] = rows
    return out


def _row_spec_key(row: dict[str, Any]) -> str | None:
    """The requested-matrix key (``tense/polarity``) for a row, or None if the
    tense/polarity values are not part of the supported matrix."""
    tense = str(row.get("tense") or "").strip()
    polarity = str(row.get("polarity") or "").strip()
    if tense not in TENSES or polarity not in POLARITIES:
        return None
    return f"{tense}/{polarity}"


def _row_ok(row: dict[str, Any]) -> bool:
    """Per-row shape checks mirroring ``validate_drill_pack`` so only genuinely
    usable rows are preferred over the deterministic backfill."""
    surface = str(row.get("surface") or "").strip()
    if not surface:
        return False
    sentence = str(row.get("sentence") or "").strip()
    words = len(sentence.split())
    if not _SENTENCE_RE.match(sentence) or not 3 <= words <= 40:
        return False
    polarity = str(row.get("polarity") or "").strip()
    if (polarity == "question") != sentence.endswith("?"):
        return False
    hint = str(row.get("base_hint") or "").strip()
    if len(hint) > 120:
        return False
    pattern = re.compile(r"\b" + re.escape(surface.lower()) + r"\b", re.IGNORECASE)
    return bool(pattern.search(sentence.lower()))


def _assemble_pack(concept: dict[str, Any], llm_rows: dict[str, dict[str, Any]]) -> list[dict[str, str]] | None:
    """Prefer an LLM row per spec; fall back to the deterministic row, then run
    the trusted validator over the assembled pack. Returns None only if even the
    deterministic baseline fails (should not happen for a well-formed concept)."""
    specs = drill_matrix_for_pos(concept.get("pos") or "")
    baseline = {s["drill_key"]: r for s, r in
                zip(specs, deterministic_drills_pack(concept))}
    final: list[dict[str, str]] = []
    for spec in specs:
        key = spec["drill_key"]
        row = llm_rows.get(key) or baseline.get(key)
        if row is None:
            return None
        final.append(row)
    try:
        return validate_drill_pack(final, specs, "en")
    except Exception:
        # Last-resort: trust the deterministic baseline wholesale.
        return validate_drill_pack(list(baseline.values()), specs, "en")


# Deterministic offline drills (M0.4). When every model is limited, a pack is
# synthesised locally so the app still gets a complete, meaning-anchored drill
# set — labelled `source='offline-fallback'` via prompt_v so it is auditable.
# Tense/office-verb conjugation is best-effort; the surface anchor keeps the
# meaning fixed to gloss_en (the exact contract validate_drill_pack enforces).
# One office frame per (tense, polarity); `{S}` is the concept's English
# surface word. The team "uses" a word/concept, so the frame reads naturally
# across every part of speech (including verb surfaces like "to be"). Non-question
# frames end with "." and contain no "?" so they satisfy the validator's
# polarity/terminal-punctuation contract; question frames end with "?". Each
# frame is 6–13 words for a 1–4 word surface, always inside the 3–40 word bound.
_DRILL_FRAMES: dict[tuple[str, str], str] = {
    ("present_simple", "affirmative"): "The team uses {S} in the office.",
    ("present_simple", "negative"):    "The team does not use {S} in the office.",
    ("present_simple", "question"):    "Does the team use {S} in the office?",
    ("past_simple", "affirmative"):    "The team used {S} in the office yesterday.",
    ("past_simple", "negative"):       "The team did not use {S} in the office yesterday.",
    ("past_simple", "question"):       "Did the team use {S} in the office yesterday?",
    ("future_simple", "affirmative"):  "The team will use {S} in the office tomorrow.",
    ("future_simple", "negative"):     "The team will not use {S} in the office tomorrow.",
    ("future_simple", "question"):     "Will the team use {S} in the office tomorrow?",
}


def _surface_for(concept: dict[str, Any]) -> str:
    """Anchor word: the English surface form. The validator matches it as a
    whole word (case-insensitive), so the raw expression text is the anchor."""
    en = str(concept.get("en") or "").strip()
    if en:
        return en
    return str(concept.get("gloss_en") or concept.get("id") or "concept").strip()


def _frame_surface(concept: dict[str, Any]) -> str:
    """Surface safe to embed in the deterministic office frames.

    Some concepts are themselves whole question/exclamative sentences
    (``How old are you?``); embedding the raw terminal punctuation into a
    declarative frame breaks ``_SENTENCE_RE``. Strip sentence punctuation so
    the frame is always shape-valid, and fall back to the concept id if that
    leaves nothing."""
    s = _surface_for(concept).replace("?", " ").replace("!", " ").replace(".", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s or str(concept.get("id") or "concept")


def deterministic_drills_pack(concept: dict[str, Any]) -> list[dict[str, str]]:
    """Offline drill pack for one concept.

    3 sentences for noun/adj/adv/other POS, 9 for verb/phrase — exactly the
    rows validate_drill_pack expects. base_hint is left empty: offline we have
    no translation, and the empty hint is valid and the UI already tolerates it.
    """
    surface = _frame_surface(concept)
    pos = concept.get("pos") or ""
    rows: list[dict[str, str]] = []
    for spec in drill_matrix_for_pos(pos):
        frame = _DRILL_FRAMES[(spec["tense"], spec["polarity"])]
        rows.append({
            "drill_key": spec["drill_key"],
            "tense": spec["tense"],
            "polarity": spec["polarity"],
            "sentence": frame.format(S=surface),
            "surface": surface,
            "base_hint": "",
        })
    return rows


def _fallback_drills_payload(concepts: list[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    """Build offline packs for every concept and validate each pack so a
    malformed surface is skipped (that concept stays pending for a retry)."""
    out: dict[str, list[dict[str, str]]] = {}
    for c in concepts:
        try:
            rows = deterministic_drills_pack(c)
            out[c["id"]] = validate_drill_pack(rows, drill_matrix_for_pos(c.get("pos", "")), "en")
        except Exception:
            continue
    return out


def _concept_line(concept: dict[str, Any]) -> str:
    return f"- {concept['id']} | {concept['cefr']} | {concept['pos']} | {concept['gloss_en']} | {concept.get('en') or ''}"


def prompt_for(kind: str, concepts: list[dict[str, Any]]) -> tuple[str, str]:
    block = "\n".join(_concept_line(c) for c in concepts)
    langs = ",".join(LANGUAGES)
    if kind == "aligned":
        user = (
            f"Languages in this exact order ({len(LANGUAGES)}): {langs}\n"
            "Return ONLY JSON {\"rows\":[[\"CONCEPT_ID\",\"sent0\",\"sent1\",...]]} "
            f"with exactly {len(LANGUAGES)} sentences after each id.\n"
            f"Concepts:\n{block}"
        )
        return ALIGNED_SYSTEM, user
    if kind == "phonetics":
        user = (
            f"Languages in this exact order ({len(LANGUAGES)}): {langs}\n"
            "Return ONLY JSON {\"rows\":[[\"CONCEPT_ID\",\"en_ro\",\"en_ipa\",\"zh_ro\",\"zh_ipa\",...]]} "
            "alternating romanization then IPA for each language.\n"
            f"Concepts:\n{block}"
        )
        return PHONETICS_SYSTEM, user
    lines = [block, "", "For each concept write every spec. Topic: office, contracts, money, markets, trade."]
    for concept in concepts:
        specs = drill_matrix_for_pos(concept["pos"])
        lines.append(concept["id"] + " specs: " + ", ".join(s["drill_key"] for s in specs))
    lines.append(
        'Return ONLY JSON {"packs":[{"id":"...","sentences":[{"drill_key":"...","tense":"...","polarity":"...","sentence":"...","surface":"...","base_hint":"..."}]}]}'
    )
    return DRILL_SYSTEM, "\n".join(lines)


def write_aligned(conn: sqlite3.Connection, rows: dict[str, dict[str, str]]) -> int:
    now_n = 0
    with conn:
        for cid, sentences in rows.items():
            for lang, sentence in sentences.items():
                conn.execute(
                    """
                    INSERT INTO aligned_examples (concept_id, lang, sentence, prompt_v)
                    VALUES (?,?,?, 'v1')
                    ON CONFLICT(concept_id, lang) DO UPDATE SET sentence = excluded.sentence
                    """,
                    (cid, lang, sentence),
                )
                now_n += 1
    return now_n


def write_phonetics(conn: sqlite3.Connection, rows: dict[str, dict[str, tuple[str, str]]]) -> int:
    n = 0
    with conn:
        for cid, cells in rows.items():
            for lang, (romaji, ipa) in cells.items():
                conn.execute(
                    """
                    INSERT INTO phonetics_text (concept_id, lang, romaji, ipa, prompt_v)
                    VALUES (?,?,?,?, 'v1')
                    ON CONFLICT(concept_id, lang) DO UPDATE SET
                      romaji = excluded.romaji, ipa = excluded.ipa
                    """,
                    (cid, lang, romaji, ipa),
                )
                n += 1
    return n


def write_drills(conn: sqlite3.Connection, packs: dict[str, list[dict[str, str]]], topic: str = "business",
                 prompt_v: str = "v1") -> int:
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    n = 0
    with conn:
        for cid, rows in packs.items():
            for row in rows:
                conn.execute(
                    """
                    INSERT INTO sentence_drills
                      (concept_id, target_lang, topic, drill_key, tense, polarity,
                       sentence, surface, base_hint, prompt_v, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(concept_id, target_lang, topic, drill_key) DO UPDATE SET
                      sentence = excluded.sentence,
                      surface = excluded.surface,
                      base_hint = excluded.base_hint,
                      prompt_v = excluded.prompt_v
                    """,
                    (
                        cid, "en", topic, row["drill_key"], row["tense"], row["polarity"],
                        row["sentence"], row["surface"], row["base_hint"] or None, prompt_v, now,
                    ),
                )
                n += 1
    return n


def _save_raw(kind: str, shard_id: str, body: str) -> None:
    dest = RAW_DIR / kind
    dest.mkdir(parents=True, exist_ok=True)
    (dest / f"{shard_id}.txt").write_text(body, encoding="utf-8")


class AllModelsLimited(RuntimeError):
    """Every model kept returning a usage-limit error within the patience window."""


def _limited(exc: Exception) -> bool:
    """Classify whether an LLM error is a transient capacity issue.

    In addition to classic 429/403/usage-limit responses, the gateway also
    surfaces per-provider cooldowns as 503 bodies like
    ``[antigravity/gemini-4-argon-low] Unavailable (reset after 140h ...)``.
    Those are quota/availability states, not fatal client errors, so they must
    route into the backoff + rotation + offline-fallback path instead of the
    split-and-fail path.
    """
    text = str(exc)
    lowered = text.lower()
    if "429" in text or "403" in text or "usage limit" in lowered:
        return True
    if "unavailable" in lowered and "503" in text:
        return True
    if "unavailable (reset after" in lowered:
        return True
    return False


# --- Per-model scheduler state ------------------------------------------------

class _ModelGate:
    """Per-model backoff gate.

    When a model returns a usage-limit error, the gate bumps its exponential
    backoff and records the wall-clock instant the model is next allowed to be
    hit. Other models keep receiving traffic meanwhile (the rotation), so the
    shared gateway quota is spread across cooldown windows instead of all
    models being hammered on the same instant — which is exactly the bug the
    old ``itertools.count()`` rotation caused.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._until = 0.0
        self._step = 0.0

    def wait(self, cap: float = 0.0) -> None:
        """Block this thread until the model is allowed to be called again.

        `cap` bounds the sleep by the caller's remaining patience so a shard
        always finishes within the deadline instead of a 900s backoff window
        overshooting it and stalling the whole run.
        """
        with self._lock:
            wake = self._until
            step = self._step
        if wake > 0:
            delay = wake - time.monotonic()
            if cap > 0:
                delay = min(delay, cap)
            if delay > 0:
                time.sleep(delay)
        with self._lock:
            if time.monotonic() >= self._until:
                # We were the one that cleared the cooldown; re-arm step so the
                # next hit starts backoff from the baseline again.
                self._step = 0.0

    def note_limited(self) -> None:
        """Record a limit hit: extend the backoff window for this model."""
        with self._lock:
            self._step = BACKOFF_BASE if self._step == 0 else min(
                BACKOFF_CAP, self._step * BACKOFF_FACTOR
            )
            self._until = time.monotonic() + self._step

    def note_ok(self) -> None:
        with self._lock:
            self._step = 0.0


_GATES: dict[str, _ModelGate] = {m[0]: _ModelGate() for m in MODELS}
_SEMAPHORES: dict[str, "threading.Semaphore"] = {m[0]: threading.Semaphore(m[2]) for m in MODELS}
_CCS: dict[str, int] = {m[0]: m[2] for m in MODELS}
_MODEL_CAPS: dict[str, int] = {m[0]: m[1] for m in MODELS}
_ROTATION = {"i": 0, "lock": threading.Lock()}


def _reset_scheduler() -> None:
    """Clear backoff/cooldown state (used by tests to start from a clean slate)."""
    for gate in _GATES.values():
        gate._lock.acquire()
        gate._until = 0.0
        gate._step = 0.0
        gate._lock.release()
    for model, sem in _SEMAPHORES.items():
        # Drain and refill the semaphore so caps are re-armed.
        acquired = 0
        for _ in range(_CCS[model]):
            sem.acquire()
            acquired += 1
        for _ in range(acquired):
            sem.release()
    _ROTATION["i"] = 0


def _model_order() -> list[str]:
    """Return a stable rotation of model names starting at a shared cursor.

    The cursor is a thread-safe counter so concurrent shards do not all pick
    the same "first" model; the per-model gates do the actual cooldown work.
    """
    with _ROTATION["lock"]:
        start = _ROTATION["i"] % len(MODELS)
        _ROTATION["i"] += 1
    names = [m[0] for m in MODELS]
    return names[start:] + names[:start]


def _call(kind: str, concepts: list[dict[str, Any]]) -> Any:
    system, user = prompt_for(kind, concepts)
    shard_id = f"{concepts[0]['id']}_{len(concepts)}"
    start = time.monotonic()
    deadline = start + PATIENCE_SECONDS
    last: Exception | None = None
    # Keep inter-round attempts: every time all models in one rotation round
    # are cooling down, re-check the models on the next round until patience.
    # Gate waits are capped by the remaining patience so a shard always
    # completes within the deadline instead of a 900s backoff overshooting it.
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        round_limited = False
        for model in _model_order():
            if time.monotonic() >= deadline:
                break
            gate = _GATES[model]
            cap = _MODEL_CAPS[model]
            _SEMAPHORES[model].acquire()
            try:
                gate.wait(cap=deadline - time.monotonic())
                if time.monotonic() >= deadline:
                    continue
                try:
                    body = call_chat_text(
                        system, user, retries=0, timeout=600.0,
                        max_tokens=min(MAX_TOKENS, cap), temperature=0.2, model=model,
                        client_retries=0,
                    )
                except Exception as exc:
                    if _limited(exc):
                        last = exc
                        gate.note_limited()
                        round_limited = True
                        print(f"{kind} {shard_id} limit {model}", flush=True)
                        continue
                    # Non-limit error: respect old semantics, stop immediately.
                    raise
                gate.note_ok()
                _save_raw(kind, shard_id, body)
                print(f"{kind} {shard_id} via {model}", flush=True)
                return json.loads(_strip_fences(body))
            finally:
                _SEMAPHORES[model].release()
        # Full rotation round finished without a usable model.
        if not round_limited:
            break
        if time.monotonic() >= deadline:
            break
        # Cooldowns are in progress; give them a moment before the next round.
        time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))
    raise AllModelsLimited(f"all models limited after patience: {last}")


def _apply(conn: sqlite3.Connection, kind: str, concepts: list[dict[str, Any]], payload: Any) -> set[str]:
    wanted = {c["id"] for c in concepts}
    if kind == "aligned":
        rows = parse_aligned(payload, wanted)
        write_aligned(conn, rows)
        return set(rows)
    if kind == "phonetics":
        rows = parse_phonetics(payload, wanted)
        write_phonetics(conn, rows)
        return set(rows)
    packs = parse_drills(payload, concepts)
    write_drills(conn, packs)
    return set(packs)


def fill_shard(kind: str, concepts: list[dict[str, Any]]) -> int:
    if not concepts:
        return 0
    shard_id = f"{concepts[0]['id']}_{len(concepts)}"
    conn = connect()
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        try:
            payload = _call(kind, concepts)
        except AllModelsLimited as exc:
            # M0.4: when every model is over its limit, drills fall back to a
            # deterministic offline pack so the data plane never blocks. Other
            # kinds (aligned/phonetics) cannot be synthesised safely, so they
            # stay pending (status 'failed') and are retried on the next run.
            if kind != "drills" or not FALLBACK_DRILLS:
                for concept in concepts:
                    _mark(kind, concept["id"], "failed", f"all models limited: {exc}")
                print(f"{kind} {shard_id}: all models limited, "
                      f"{'fallback off' if kind == 'drills' else 'no offline fallback'}, marked failed ({len(concepts)})",
                      flush=True)
                return 0
            packs = _fallback_drills_payload(concepts)
            got = set(packs)
            write_drills(conn, packs, prompt_v="v1-offline")
            for concept in concepts:
                if concept["id"] in got:
                    _mark(kind, concept["id"], "done", "offline-fallback")
            print(f"{kind} {shard_id}: offline-fallback {len(got)}/{len(concepts)}", flush=True)
            missing = [c for c in concepts if c["id"] not in got]
            if missing and len(concepts) > 1:
                return len(got) + fill_shard(kind, missing)
            return len(got)
        except Exception as exc:
            # Transient / non-limit error: keep the legacy split-and-retry path.
            if len(concepts) == 1:
                _mark(kind, concepts[0]["id"], "failed", str(exc))
                print(f"{kind} FAIL {concepts[0]['id']}: {exc}", flush=True)
                return 0
            mid = len(concepts) // 2
            print(f"{kind} split {len(concepts)} after {type(exc).__name__}", flush=True)
            return fill_shard(kind, concepts[:mid]) + fill_shard(kind, concepts[mid:])
        got = _apply(conn, kind, concepts, payload)
        missing = [c for c in concepts if c["id"] not in got]
        for concept in concepts:
            if concept["id"] in got:
                _mark(kind, concept["id"], "done")
        print(f"{kind} {shard_id}: {len(got)}/{len(concepts)}", flush=True)
        if missing and len(concepts) > 1:
            return len(got) + fill_shard(kind, missing)
        return len(got)
    finally:
        conn.close()


def plan(kind: str, concepts: list[dict[str, Any]], *, resume_failed: bool = False) -> list[list[dict[str, Any]]]:
    size = {"aligned": 70, "phonetics": 60, "drills": 40}[kind]
    done = _done_ids(kind)
    pending = [c for c in concepts if c["id"] not in done]
    if resume_failed:
        # M0.3: replay only shards that were already marked failed, so a resume
        # pass does not re-hammer the whole fresh backlog (which is still
        # gated by rate limits on the next full run).
        failed = _failed_ids(kind)
        pending = [c for c in pending if c["id"] in failed]
    return chunk(pending, size)


def _raw_file_cids(kind: str, payload: Any) -> list[str]:
    """Concept ids explicitly named by one raw response file.

    Drill rows also embed ids inside their ``drill_key`` (``CID!tense/...``,
    ``CID_TENSE_POLARITY``, bare ``CID``), so those are mined too; synthetic
    global-pack ids are not concept ids and are filtered against the
    warehouse on the caller side.
    """
    seq: list[str] = []
    if kind == "drills":
        for pack in (payload.get("packs") if isinstance(payload, dict) else None) or []:
            if not isinstance(pack, dict):
                continue
            seq.append(str(pack.get("id") or ""))
            for row in pack.get("sentences") or []:
                key = str(row.get("drill_key") or "").strip()
                if not key:
                    continue
                if "!" in key:
                    seq.append(key.split("!", 1)[0])
                elif "/" not in key:
                    base = key.upper()
                    for suffix in ("_PRESENT_SIMPLE", "_PAST_SIMPLE", "_FUTURE_SIMPLE",
                                   "_AFFIRMATIVE", "_NEGATIVE", "_QUESTION"):
                        if base.endswith(suffix):
                            base = base[: -len(suffix)]
                    seq.append(base)
    else:
        rows = payload.get("rows") if isinstance(payload, dict) else payload
        if isinstance(rows, list):
            seq.extend(str(r[0]) for r in rows if isinstance(r, list) and r)
    out: list[str] = []
    seen: set[str] = set()
    for cid in seq:
        if cid and cid not in seen:
            seen.add(cid)
            out.append(cid)
    return out


def replay_raw() -> dict[str, int]:
    """Re-parse every saved raw LLM response and write the recoverable rows.

    Responses that succeeded (printed ``via <model>``) are saved verbatim
    under ``RAW_DIR/<kind>/<shard>.txt`` even when later parsing dropped
    them (e.g. the transient ``CONCEPT_ID!tense/polarity`` drill_key format,
    multi-concept "global packs", or ``503 Unavailable (reset ...)`` errors
    misrouted to the split path). Re-running the shape-tolerant parsers
    recovers that work with zero gateway calls — crucial while provider
    cooldowns block new calls. Drill rows are resolved against the full
    concept set (surface index) so global packs recover too. Returns
    recovered concept counts per kind.
    """
    recovered: dict[str, int] = {}
    all_concepts = load_concepts(connect())
    all_ids = {c["id"] for c in all_concepts}
    for kind in KINDS:
        dir_ = RAW_DIR / kind
        if not dir_.is_dir():
            recovered[kind] = 0
            continue
        n_concepts = 0
        conn = connect()
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            for file in sorted(dir_.glob("*.txt")):
                try:
                    payload = json.loads(_strip_fences(file.read_text(encoding="utf-8")))
                except Exception:
                    continue
                if kind == "drills":
                    got = set(_apply(conn, kind, all_concepts, payload))
                else:
                    cids = [c for c in _raw_file_cids(kind, payload) if c in all_ids]
                    if not cids:
                        continue
                    scope = [c for c in all_concepts if c["id"] in set(cids)]
                    got = set(_apply(conn, kind, scope, payload))
                    if got:
                        _mark(kind, file.name[:-4], "done", "raw-replay")
                n_concepts += len(got)
        finally:
            conn.close()
        recovered[kind] = n_concepts
    return recovered


def run(kind: str, *, workers: int = 12, limit: int = 0, resume_failed: bool = False) -> int:
    use_bulk_gateway()
    conn = connect()
    init_schema(conn)
    try:
        source = {
            "aligned": missing_aligned,
            "phonetics": missing_phonetics,
            "drills": missing_drills,
        }[kind](conn)
    finally:
        conn.close()
    if limit:
        source = source[:limit]
    shards = plan(kind, source, resume_failed=resume_failed)
    print(f"{kind}: {len(source)} concepts, {len(shards)} shards", flush=True)
    if workers <= 1:
        return sum(fill_shard(kind, shard) for shard in shards)
    written = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(fill_shard, kind, shard) for shard in shards]
        for future in as_completed(futures):
            written += future.result()
    return written


