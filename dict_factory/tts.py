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
so a given (lang, voice, text) is synthesized once.
"""
from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import time
from collections import OrderedDict
from dataclasses import dataclass

from dict_factory.config import OUT_DIR

TTS_CACHE_DB = OUT_DIR / "tts_cache.db"
MAX_TEXT_LEN = 300
LRU_MAX = 32

# 35 product languages -> default Microsoft Edge neural voice
# (ported from the extension's bingTtsVoices catalog, default voice per language).
VOICE_CATALOG: dict[str, str] = {
    "en": "en-US-AriaNeural",
    "vi": "vi-VN-HoaiMyNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
    "ja": "ja-JP-NanamiNeural",
    "ko": "ko-KR-SunHiNeural",
    "hi": "hi-IN-SwaraNeural",
    "es": "es-ES-ElviraNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
    "pt": "pt-BR-FranciscaNeural",
    "ru": "ru-RU-SvetlanaNeural",
    "ar": "ar-SA-ZariyahNeural",
    "bn": "bn-BD-NabanitaNeural",
    "id": "id-ID-GadisNeural",
    "ms": "ms-MY-YasminNeural",
    "th": "th-TH-PremwadeeNeural",
    "tr": "tr-TR-EmelNeural",
    "it": "it-IT-ElsaNeural",
    "nl": "nl-NL-ColetteNeural",
    "pl": "pl-PL-ZofiaNeural",
    "uk": "uk-UA-OstapNeural",
    "el": "el-GR-AthinaNeural",
    "cs": "cs-CZ-AntoninNeural",
    "sv": "sv-SE-MattiasNeural",
    "da": "da-DK-ChristelNeural",
    "fi": "fi-FI-HarriNeural",
    "no": "nb-NO-FinnNeural",
    "hu": "hu-HU-NoemiNeural",
    "ro": "ro-RO-AlinaNeural",
    "he": "he-IL-AvriNeural",
    "fa": "fa-IR-DilaraNeural",
    "ur": "ur-IN-GulNeural",
    "ta": "ta-IN-PallaviNeural",
    "te": "te-IN-MohanNeural",
    "sw": "sw-KE-RafikiNeural",
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


def resolve_voice(lang: str) -> str:
    """Catalog voice for a product language (aliases no->nb family, he->iw).

    Raises TtsVoiceError when the language is unknown or the voice's family
    would not match the language (no silent English fallback)."""
    code = _primary_subtag(lang)
    voice = VOICE_CATALOG.get(code)
    if voice is None:
        raise TtsVoiceError(f"no TTS voice catalogued for language {code!r}")
    family = voice.split("-")[0]
    if family not in allowed_families(code):
        raise TtsVoiceError(f"voice {voice!r} family {family!r} does not match language {code!r}")
    return voice


def voice_info(lang: str) -> dict[str, str]:
    voice = resolve_voice(lang)
    code = _primary_subtag(lang)
    return {
        "lang": code,
        "voice": voice,
        "family": voice.split("-")[0],
        "alias": VOICE_ALIAS.get(code, ""),
    }


# ---------------------------------------------------------------------------
# Vendors
# ---------------------------------------------------------------------------

class TtsVendor:
    """A free TTS source. Subclasses set `name` and implement synthesize()."""

    name: str = ""

    def synthesize(self, text: str, voice: str, lang: str) -> tuple[bytes, str]:
        raise NotImplementedError


class EdgeTtsVendor(TtsVendor):
    """Microsoft Edge neural voices via the free edge-tts service."""

    name = "edge"

    def synthesize(self, text: str, voice: str, lang: str) -> tuple[bytes, str]:
        import edge_tts

        async def _run() -> bytes:
            communicate = edge_tts.Communicate(text=text, voice=voice)
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

    def synthesize(self, text: str, voice: str, lang: str) -> tuple[bytes, str]:
        import io

        from gtts import gTTS

        data = io.BytesIO()
        gTTS(text=text, lang=_GTTS_CODES[_primary_subtag(lang)]).write_to_fp(data)
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

def _cache_key(lang: str, voice: str, text: str) -> str:
    return hashlib.sha1(f"{_primary_subtag(lang)}|{voice}|{text}".encode("utf-8")).hexdigest()


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
    vendors: list[TtsVendor] | None = None,
    health: VendorHealth | None = None,
    cache: sqlite3.Connection | None = None,
) -> TtsResult:
    """Cache-first synthesis. One vendor call per unique (lang, voice, text);
    repeat plays come from memory, then the persistent cache."""
    text = (text or "").strip()
    if not text:
        raise TtsError("empty text")
    if len(text) > MAX_TEXT_LEN:
        raise TtsError(f"text longer than {MAX_TEXT_LEN} chars")
    voice = resolve_voice(lang)  # raises TtsVoiceError (400) on unknown/mismatched lang
    key = _cache_key(lang, voice, text)

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
            _MEM_CACHE.put(key, (row[1], row[0], voice))
            conn.execute(
                "UPDATE tts_cache SET hits = hits + 1, created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key = ?",
                (key,),
            )
            conn.commit()
            return TtsResult(row[1], row[0], voice, "cache")
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
            audio, mime = vendor.synthesize(text, voice, lang)
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
                (key, _primary_subtag(lang), voice, mime, audio, now),
            )
            persistent_cache.commit()
        finally:
            if cache is None:
                persistent_cache.close()
        _MEM_CACHE.put(key, (audio, mime, voice))
        return TtsResult(audio, mime, voice, vendor.name)
    raise TtsVendorError("; ".join(errors) or "no TTS vendor configured")


# Module singletons so routes and tests share one ladder + health registry.
DEFAULT_LADDER: list[TtsVendor] = build_default_ladder()
DEFAULT_HEALTH = VendorHealth()
