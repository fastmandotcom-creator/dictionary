"""Free-online TTS service (Phase E1): standard-quality neural voices for all
35 product languages, cache-first.

Architecture mirrors the extension's TTS ladder (ContentScriptTTS /
FreeOnlineTTSUtterance / ttsTierLadder): a network neural-voice tier is tried
before anything else, and the browser's Web Speech API remains the client-side
floor (last resort, surfaced as "giọng trình duyệt" — never a silent
substitution). The voice catalog below is ported from the extension's
``bingTtsVoices`` so all 35 languages resolve to a real, correct-family voice
and the system refuses to play an English voice for a non-English language.

Vendors (best first): Microsoft Edge neural TTS (edge-tts), Google free TTS
(gTTS). Both are free; audio is cached (``out/tts_cache.db`` + in-memory LRU)
so a given (lang, voice, rate, text) is synthesized once.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from dict_factory.config import OUT_DIR

TTS_CACHE_DB = OUT_DIR / "tts_cache.db"
MAX_TEXT_LEN = 300
LRU_MAX = 32

# Full per-language voice catalog (35 product languages -> default Edge
# neural voice + every regional option), ported from the extension's
# bingTtsVoices. The first option is the default for that language.
_VOICE_DATA_PATH = Path(__file__).resolve().parent / "tts_voices.json"
_VOICE_DATA: dict[str, dict[str, object]] = json.loads(_VOICE_DATA_PATH.read_text(encoding="utf-8"))

VOICE_CATALOG: dict[str, str] = {
    code: str(data["default"]) for code, data in _VOICE_DATA.items()
}
VOICE_OPTIONS: dict[str, list[str]] = {
    code: [str(v) for v in data["options"]] for code, data in _VOICE_DATA.items()
}

# Documented alias families (same as the extension): 'no' is spoken in
# Norwegian Bokmål ('nb') voices; 'he' historically maps to 'iw'.
VOICE_ALIAS: dict[str, str] = {"no": "nb", "he": "iw"}

# gTTS (Google free TTS) language codes for our 35 languages.
_GTTS_CODES: dict[str, str] = {
    "zh": "zh-cn",
    "pt": "pt-br",
    "no": "no",
    **{k: k for k in VOICE_CATALOG if k not in ("zh", "pt")},
}


class TtsError(Exception):
    """Base class for TTS failures surfaced by the API."""


class TtsVoiceError(TtsError):
    """The language has no voice in the catalog, or a wrong-family voice.

    The API must never fall back to an English voice for a non-English
    language — callers should then use their own browser floor."""


class TtsVendorError(TtsError):
    """All network vendors failed (offline / rate-limited / unsupported)."""


def _primary_subtag(lang: str) -> str:
    return (lang or "").strip().lower().split("-")[0]


def allowed_families(lang: str) -> set[str]:
    code = _primary_subtag(lang)
    return {code, VOICE_ALIAS.get(code, "")} - {""}


def resolve_voice(lang: str, voice: str | None = None) -> str:
    """Catalog voice for a product language (aliases no->nb family, he->iw).

    With `voice` given (a user-selected option), it must belong to the
    language's catalog options and keep the correct family. Raises
    TtsVoiceError when the language is unknown, the voice is not catalogued
    for it, or the family would not match (no silent English fallback)."""
    code = _primary_subtag(lang)
    options = VOICE_OPTIONS.get(code)
    if options is None:
        raise TtsVoiceError(f"no TTS voice catalogued for language {code!r}")
    if voice:
        if voice not in options:
            raise TtsVoiceError(f"voice {voice!r} is not offered for language {code!r}")
    else:
        voice = VOICE_CATALOG[code]
    family = voice.split("-")[0]
    if family not in allowed_families(code):
        raise TtsVoiceError(f"voice {voice!r} family {family!r} does not match language {code!r}")
    return voice


def voice_info(lang: str) -> dict[str, str]:
    code = _primary_subtag(lang)
    options = VOICE_OPTIONS.get(code)
    if options is None:
        raise TtsVoiceError(f"no TTS voice catalogued for language {code!r}")
    return {
        "lang": code,
        "voice": VOICE_CATALOG.get(code, options[0]),
        "options": list(options),
        "family": VOICE_CATALOG.get(code, options[0]).split("-")[0],
        "alias": VOICE_ALIAS.get(code, ""),
    }


# ---------------------------------------------------------------------------
# Vendors
# ---------------------------------------------------------------------------

class TtsVendor:
    """A free TTS source. Subclasses set `name` and implement synthesize()."""

    name: str = ""

    def synthesize(self, text: str, voice: str, lang: str, rate: float = 1.0) -> tuple[bytes, str]:
        raise NotImplementedError


class EdgeTtsVendor(TtsVendor):
    """Microsoft Edge neural voices via the free edge-tts service."""

    name = "edge"

    def synthesize(self, text: str, voice: str, lang: str, rate: float = 1.0) -> tuple[bytes, str]:
        import edge_tts

        async def _run() -> bytes:
            communicate = edge_tts.Communicate(text=text, voice=voice, rate=f"{int((rate - 1) * 100)}%")
            chunks: list[bytes] = []
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio":
                    chunks.append(chunk.get("data") or b"")
            return b"".join(chunks)

        audio = asyncio.run(_run())
        if not audio:
            raise RuntimeError("edge-tts returned no audio")
        return audio, "audio/mpeg"


class GoogleFreeTtsVendor(TtsVendor):
    """Google free TTS (gTTS) — language-level, no voice choice."""

    name = "google"

    def synthesize(self, text: str, voice: str, lang: str, rate: float = 1.0) -> tuple[bytes, str]:
        import io

        from gtts import gTTS

        data = io.BytesIO()
        # gTTS only offers normal or slow; map rate 0.7 -> slow
        gTTS(text=text, lang=_GTTS_CODES[_primary_subtag(lang)], slow=(rate < 1.0)).write_to_fp(data)
        audio = data.getvalue()
        if not audio:
            raise RuntimeError("gTTS returned no audio")
        return audio, "audio/mpeg"


def build_default_ladder() -> list[TtsVendor]:
    return [EdgeTtsVendor(), GoogleFreeTtsVendor()]


class VendorHealth:
    """Minimal circuit breaker: a failed vendor cools down for 60s."""

    COOLDOWN_S = 60

    def __init__(self) -> None:
        self._down_until: dict[str, float] = {}

    def available(self, vendor: TtsVendor) -> bool:
        return time.time() >= self._down_until.get(vendor.name, 0.0)

    def record_failure(self, vendor: TtsVendor) -> None:
        self._down_until[vendor.name] = time.time() + self.COOLDOWN_S

    def record_success(self, vendor: TtsVendor) -> None:
        self._down_until.pop(vendor.name, None)


# ---------------------------------------------------------------------------
# Cache (persist + in-memory LRU)
# ---------------------------------------------------------------------------

def _cache_key(lang: str, voice: str, rate: float, text: str) -> str:
    return hashlib.sha1(
        f"{_primary_subtag(lang)}|{voice}|{rate:g}|{text}".encode("utf-8")
    ).hexdigest()


def _ensure_cache_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tts_cache (
          key TEXT PRIMARY KEY,
          lang TEXT NOT NULL,
          voice TEXT NOT NULL,
          mime TEXT NOT NULL,
          data BLOB NOT NULL,
          created_at TEXT NOT NULL,
          hits INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.commit()


def _open_cache(path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path or TTS_CACHE_DB))
    _ensure_cache_schema(conn)
    return conn


class _Lru:
    def __init__(self, max_size: int = LRU_MAX) -> None:
        self._data: "OrderedDict[str, tuple[bytes, str, str]]" = OrderedDict()
        self._max = max_size

    def get(self, key: str) -> tuple[bytes, str, str] | None:
        if key in self._data:
            self._data.move_to_end(key)
            return self._data[key]
        return None

    def put(self, key: str, item: tuple[bytes, str, str]) -> None:
        self._data[key] = item
        self._data.move_to_end(key)
        while len(self._data) > self._max:
            self._data.popitem(last=False)


_MEM_CACHE = _Lru()


@dataclass
class TtsResult:
    audio: bytes
    mime: str
    voice: str
    source: str  # "cache" | vendor name

    def as_dict(self) -> dict[str, str]:
        return {"voice": self.voice, "source": self.source, "mime": self.mime, "bytes": len(self.audio)}


def synthesize_cached(
    lang: str,
    text: str,
    *,
    voice: str | None = None,
    rate: float = 1.0,
    vendors: list[TtsVendor] | None = None,
    health: VendorHealth | None = None,
    cache: sqlite3.Connection | None = None,
) -> TtsResult:
    """Cache-first synthesis. One vendor call per unique
    (lang, voice, rate, text); repeat plays come from memory, then the
    persistent cache."""
    text = (text or "").strip()
    if not text:
        raise TtsError("empty text")
    if len(text) > MAX_TEXT_LEN:
        raise TtsError(f"text longer than {MAX_TEXT_LEN} chars")
    rate = 0.7 if rate < 1.0 else 1.0  # only two speeds are meaningful
    resolved_voice = resolve_voice(lang, voice)  # raises TtsVoiceError (400)
    key = _cache_key(lang, resolved_voice, rate, text)

    hit = _MEM_CACHE.get(key)
    if hit is not None:
        audio, mime, src_voice = hit
        return TtsResult(audio, mime, src_voice, "cache")

    conn = cache
    persistent = conn is not None
    if not persistent:
        conn = _open_cache()
    else:
        _ensure_cache_schema(conn)
    try:
        row = conn.execute("SELECT mime, data FROM tts_cache WHERE key = ?", (key,)).fetchone()
        if row is not None:
            _MEM_CACHE.put(key, (row[1], row[0], resolved_voice))
            conn.execute(
                "UPDATE tts_cache SET hits = hits + 1, created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key = ?",
                (key,),
            )
            conn.commit()
            return TtsResult(row[1], row[0], resolved_voice, "cache")
    finally:
        if not persistent:
            conn.close()

    ladder = vendors if vendors is not None else DEFAULT_LADDER
    health = health or DEFAULT_HEALTH
    errors: list[str] = []
    for vendor in ladder:
        if not health.available(vendor):
            errors.append(f"{vendor.name}: cooling down")
            continue
        try:
            audio, mime = vendor.synthesize(text, resolved_voice, lang, rate)
        except Exception as exc:  # noqa: BLE001 - vendor surface is untyped
            health.record_failure(vendor)
            errors.append(f"{vendor.name}: {exc}")
            continue
        health.record_success(vendor)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        persistent_cache = cache or _open_cache()
        try:
            persistent_cache.execute(
                """
                INSERT INTO tts_cache (key, lang, voice, mime, data, created_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(key) DO UPDATE SET hits = hits + 1
                """,
                (key, _primary_subtag(lang), resolved_voice, mime, audio, now),
            )
            persistent_cache.commit()
        finally:
            if cache is None:
                persistent_cache.close()
        _MEM_CACHE.put(key, (audio, mime, resolved_voice))
        return TtsResult(audio, mime, resolved_voice, vendor.name)
    raise TtsVendorError("; ".join(errors) or "no TTS vendor configured")


# Module singletons so routes and tests share one ladder + health registry.
DEFAULT_LADDER: list[TtsVendor] = build_default_ladder()
DEFAULT_HEALTH = VendorHealth()
