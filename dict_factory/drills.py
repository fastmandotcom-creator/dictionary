"""Advanced listen-and-write drills (Phase D1): cache-first drill packs.

Design (per the learner's requirements):
- Meaning is always anchored to the concept's gloss_en — a pack is generated
  per (concept, target_lang, topic) and CACHED in `sentence_drills`, so the
  second learner of the same concept+topic costs zero LLM tokens.
- The LLM provider is only called on a cache miss, and one call generates the
  whole bounded pack for the concept (never per-sentence, never bulk 12k).
- The drill matrix is bounded by part of speech: verbs get a tense dimension,
  everything else stays in the present; every concept gets the polarity
  dimension (affirmative / negative / question).
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import Any, Protocol

from dict_factory.prompts import SchemaViolation, prompt_messages, validate_payload

# Closed topic presets (free-form topics are intentionally out of scope:
# they would explode the cache key space and defeat the cost model).
DRILL_TOPICS: tuple[str, ...] = ("general", "business", "travel", "daily")

TENSES: tuple[str, ...] = ("present_simple", "past_simple", "future_simple")
POLARITIES: tuple[str, ...] = ("affirmative", "negative", "question")

# Bounded pack per part of speech. Verbs span tenses; other POS stay in the
# present. 9 sentences max per miss — keeps a single LLM call cheap.
def drill_matrix_for_pos(pos: str) -> list[dict[str, str]]:
    """Return the list of {tense, polarity, drill_key} to generate for a POS."""
    tenses = TENSES if pos in ("verb", "phrase") else ("present_simple",)
    return [
        {"tense": t, "polarity": p, "drill_key": f"{t}/{p}"}
        for t in tenses
        for p in POLARITIES
    ]


class DrillError(ValueError):
    """A drill pack failed validation and must not be written to the DB."""


class DrillProvider(Protocol):
    """Generates one full pack for a concept+topic. `rows` items look like:
    {"drill_key","tense","polarity","sentence","surface","base_hint"}.
    Real providers call the LLM; tests use fakes that count invocations."""

    name: str

    def generate(self, *, concept: dict[str, Any], pos: str, topic: str,
                 target_lang: str, base_lang: str, specs: list[dict[str, str]]) -> list[dict[str, str]]:
        ...


_SENTENCE_RE = re.compile(r"^[^?!.]{0,200}[?!.]?$")


def _word_count(sentence: str) -> int:
    return len(sentence.split())


def validate_drill_pack(rows: list[dict], specs: list[dict[str, str]], target_lang: str) -> list[dict[str, str]]:
    """Validate a generated pack. Raises DrillError; returns normalized rows."""
    wanted = {s["drill_key"] for s in specs}
    seen: set[str] = set()
    clean: list[dict[str, str]] = []
    for raw in rows:
        if not isinstance(raw, dict):
            raise DrillError("drill rows must be objects")
        key = str(raw.get("drill_key") or "").strip()
        if key not in wanted:
            raise DrillError(f"drill_key {key!r} not in the requested matrix {sorted(wanted)}")
        if key in seen:
            raise DrillError(f"duplicate drill_key {key!r}")
        seen.add(key)
        tense = str(raw.get("tense") or "").strip()
        polarity = str(raw.get("polarity") or "").strip()
        if f"{tense}/{polarity}" != key:
            raise DrillError(f"drill_key {key!r} inconsistent with tense={tense!r} polarity={polarity!r}")
        if tense not in TENSES or polarity not in POLARITIES:
            raise DrillError(f"unknown tense/polarity {tense!r}/{polarity!r}")
        sentence = str(raw.get("sentence") or "").strip()
        words = _word_count(sentence)
        if not _SENTENCE_RE.match(sentence) or not 3 <= words <= 40:
            raise DrillError(f"sentence fails shape rules ({words} words): {sentence[:60]!r}")
        if (polarity == "question") != sentence.endswith("?"):
            raise DrillError(f"polarity {polarity!r} must {'end with ?' if polarity == 'question' else 'not end with ?'}")
        surface = str(raw.get("surface") or "").strip()
        if not surface:
            raise DrillError(f"row {key!r} missing surface")
        # The sentence must actually use the concept's word form (anchor).
        pattern = re.compile(r"\b" + re.escape(surface.lower()) + r"\b", re.IGNORECASE)
        if not pattern.search(sentence.lower()):
            raise DrillError(f"sentence for {key!r} does not use its surface {surface!r} (meaning drift)")
        hint = str(raw.get("base_hint") or "").strip()
        if len(hint) > 120:
            raise DrillError(f"base_hint too long on {key!r}")
        clean.append({
            "drill_key": key,
            "tense": tense,
            "polarity": polarity,
            "sentence": sentence,
            "surface": surface,
            "base_hint": hint,
        })
    missing = wanted - seen
    if missing:
        raise DrillError(f"pack incomplete, missing {sorted(missing)}")
    clean.sort(key=lambda r: [s["drill_key"] for s in specs].index(r["drill_key"]))
    return clean


class LLMDrillProvider:
    """Paid-LLM provider: one prompt builds the whole pack (cache-first,
    never bulk). Raises when the gateway is unconfigured."""

    name = "llm"

    def generate(self, *, concept: dict[str, Any], pos: str, topic: str,
                 target_lang: str, base_lang: str, specs: list[dict[str, str]]) -> list[dict[str, str]]:
        spec_block = json.dumps(specs, ensure_ascii=False)
        messages = prompt_messages(
            "drills",
            version="v1",
            variables={
                "concept_id": concept["id"],
                "gloss_en": concept["gloss_en"],
                "en_surface": concept.get("en_surface", ""),
                "en_meaning": concept.get("en_meaning", ""),
                "pos": pos,
                "cefr": concept.get("cefr", ""),
                "domain": concept.get("domain", ""),
                "topic": topic,
                "target_lang": target_lang,
                "base_lang": base_lang,
                "spec_block": spec_block,
                "count": len(specs),
            },
        )
        from dict_factory.llm import call_chat_json

        # interactive call: keep it snappy (fewer retries, shorter timeout) —
        # the client also races a demo fallback so the learner is never blocked.
        payload = call_chat_json(
            messages[0]["content"], messages[1]["content"],
            retries=2, timeout=60.0,
        )
        try:
            validate_payload("drills", payload)
        except SchemaViolation as exc:
            raise DrillError(f"LLM pack failed schema: {exc}") from exc
        return list(payload["sentences"])


@dataclass(frozen=True)
class DrillPack:
    concept_id: str
    target_lang: str
    topic: str
    rows: tuple[dict[str, str], ...]
    source: str  # "cache" | provider name

    def as_dict(self) -> dict[str, Any]:
        return {
            "concept_id": self.concept_id,
            "target_lang": self.target_lang,
            "topic": self.topic,
            "source": self.source,
            "sentences": [
                {
                    "drill_key": r["drill_key"],
                    "tense": r["tense"],
                    "polarity": r["polarity"],
                    "sentence": r["sentence"],
                    "surface": r["surface"],
                    "base_hint": r["base_hint"],
                }
                for r in self.rows
            ],
        }


def _load_cache(conn: sqlite3.Connection, concept_id: str, target_lang: str, topic: str,
                wanted: set[str]) -> dict[str, dict[str, str]]:
    rows = conn.execute(
        """
        SELECT drill_key, tense, polarity, sentence, surface, base_hint
        FROM sentence_drills
        WHERE concept_id = ? AND target_lang = ? AND topic = ?
        """,
        (concept_id, target_lang, topic),
    ).fetchall()
    out: dict[str, dict[str, str]] = {}
    for r in rows:
        if r["drill_key"] in wanted:
            out[r["drill_key"]] = {
                "drill_key": r["drill_key"],
                "tense": r["tense"],
                "polarity": r["polarity"],
                "sentence": r["sentence"],
                "surface": r["surface"],
                "base_hint": r["base_hint"] or "",
            }
    return out


def get_drill_pack(
    conn: sqlite3.Connection,
    concept_id: str,
    target_lang: str,
    topic: str,
    provider: DrillProvider,
    base_lang: str = "vi",
) -> DrillPack:
    """Cache-first pack lookup. On a miss, one provider call fills the whole
    pack and writes it to the DB in a single transaction."""
    if topic not in DRILL_TOPICS:
        raise DrillError(f"unknown topic {topic!r}; known: {list(DRILL_TOPICS)}")
    concept = conn.execute(
        "SELECT c.id, c.pos, c.cefr, c.domain, c.gloss_en, c.rank, "
        "e.text AS en_surface, e.meaning AS en_meaning "
        "FROM concepts c LEFT JOIN expressions e ON e.concept_id = c.id AND e.lang = 'en' "
        "WHERE c.id = ?",
        (concept_id,),
    ).fetchone()
    if concept is None:
        raise KeyError(f"unknown concept {concept_id!r}")
    concept = dict(concept)
    if not concept["gloss_en"] or not concept["en_surface"]:
        raise DrillError(f"{concept_id!r} has no English anchor; drills require gloss_en + en surface")

    specs = drill_matrix_for_pos(concept["pos"])
    wanted = {s["drill_key"] for s in specs}
    cached = _load_cache(conn, concept_id, target_lang, topic, wanted)
    if len(cached) == len(wanted):
        rows = tuple(cached[k] for k in [s["drill_key"] for s in specs])
        return DrillPack(concept_id, target_lang, topic, rows, "cache")

    generated = provider.generate(
        concept=concept, pos=concept["pos"], topic=topic,
        target_lang=target_lang, base_lang=base_lang, specs=specs,
    )
    rows = validate_drill_pack(generated, specs, target_lang)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with conn:  # single transaction: all-or-nothing pack
        for r in rows:
            conn.execute(
                """
                INSERT INTO sentence_drills
                  (concept_id, target_lang, topic, drill_key, tense, polarity,
                   sentence, surface, base_hint, prompt_v, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(concept_id, target_lang, topic, drill_key) DO UPDATE SET
                  tense = excluded.tense,
                  polarity = excluded.polarity,
                  sentence = excluded.sentence,
                  surface = excluded.surface,
                  base_hint = excluded.base_hint,
                  prompt_v = excluded.prompt_v
                """,
                (concept_id, target_lang, topic, r["drill_key"], r["tense"], r["polarity"],
                 r["sentence"], r["surface"], r["base_hint"] or None, "v1", now),
            )
    ordered = tuple(next(r for r in rows if r["drill_key"] == s["drill_key"]) for s in specs)
    return DrillPack(concept_id, target_lang, topic, ordered, provider.name)


def list_drill_topics() -> list[str]:
    return list(DRILL_TOPICS)
