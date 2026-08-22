from __future__ import annotations

from typing import Any

from dict_factory.languages import LANGUAGES, MAX_EXPRESSION_CHARS, PHRASE_TYPES


class ExpressionError(ValueError):
    pass


def parse_lang_entry(lang: str, raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise ExpressionError(f"{lang}: entry must be an object")
    text = str(raw.get("text") or "").strip()
    meaning = str(raw.get("meaning") or "").strip()
    expression_type = str(raw.get("type") or raw.get("expression_type") or "").strip().lower()
    example = str(raw.get("example") or "").strip()
    if not text:
        raise ExpressionError(f"{lang}: missing text")
    if len(text) > MAX_EXPRESSION_CHARS:
        raise ExpressionError(f"{lang}: text longer than {MAX_EXPRESSION_CHARS}")
    if not meaning:
        raise ExpressionError(f"{lang}: missing meaning")
    if not expression_type:
        expression_type = "word"
    return {
        "text": text,
        "meaning": meaning,
        "type": expression_type,
        "example": example,
    }


def _normalize_lang_payload(raw: dict[str, Any]) -> dict[str, Any]:
    if "text" in raw or "meaning" in raw:
        return raw
    if "t" in raw or "m" in raw:
        return {
            "text": raw.get("t") or raw.get("text"),
            "meaning": raw.get("m") or raw.get("meaning"),
            "type": raw.get("k") or raw.get("type") or "word",
            "example": raw.get("e") or raw.get("example") or "",
        }
    return raw


def parse_expression_bundle(raw: Any, *, langs: tuple[str, ...] = LANGUAGES) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ExpressionError("bundle must be an object")
    raw_id = raw.get("concept_id")
    if not isinstance(raw_id, str) or not raw_id.strip():
        raw_id = raw.get("id") if isinstance(raw.get("id"), str) else ""
    concept_id = str(raw_id or "").strip()
    if not concept_id:
        raise ExpressionError("missing concept_id")
    payload = raw.get("langs") if isinstance(raw.get("langs"), dict) else raw
    payload = {
        lang: _normalize_lang_payload(value) if isinstance(value, dict) else value
        for lang, value in payload.items()
        if lang not in {"concept_id", "langs"} and not (lang == "id" and isinstance(value, str))
    }
    missing = [lang for lang in langs if lang not in payload]
    if missing:
        raise ExpressionError(f"{concept_id}: missing langs {missing}")
    parsed = {lang: parse_lang_entry(lang, payload[lang]) for lang in langs}
    return {"concept_id": concept_id, "langs": parsed}


def runtime_pos(syllabus_pos: str, expression_type: str) -> str:
    if expression_type in PHRASE_TYPES:
        return "phrase"
    return syllabus_pos
