from __future__ import annotations

import json
import os
import random
import re
import time
from pathlib import Path
from typing import Any

from dict_factory.config import ROOT

DEFAULT_MODEL = "ag/gemini-3.7-flash-low"


def _load_dotenv() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def llm_config() -> dict[str, str] | None:
    _load_dotenv()
    base_url = os.environ.get("LEXICON_LLM_BASE_URL", "").strip()
    api_key = os.environ.get("LEXICON_LLM_API_KEY", "").strip()
    model = os.environ.get("LEXICON_LLM_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    if not base_url or not api_key:
        return None
    return {"base_url": base_url, "api_key": api_key, "model": model}


def _strip_fences(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def call_chat_text(
    system: str,
    user: str,
    *,
    retries: int = 3,
    backoff: float = 1.5,
    timeout: float = 120.0,
    temperature: float = 0.2,
    max_tokens: int = 65536,
    model: str | None = None,
    client_retries: int = 2,
) -> str:
    """Run one chat completion and return the raw response text.

    ``client_retries`` maps to the OpenAI client's ``max_retries``. The
    offline-fill scheduler passes 0 so a rate-limited provider fails fast
    instead of the SDK silently retrying and burning wall time inside the
    per-model backoff loop.
    """
    cfg = llm_config()
    if cfg is None:
        raise RuntimeError("LLM is not configured (LEXICON_LLM_BASE_URL/API_KEY/MODEL).")

    from openai import OpenAI

    client = OpenAI(base_url=cfg["base_url"], api_key=cfg["api_key"], max_retries=client_retries)
    last_error: Exception | None = None
    attempt = 0
    while attempt <= retries:
        try:
            response = client.chat.completions.create(
                model=model or cfg["model"],
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=temperature,
                timeout=timeout,
                max_tokens=max_tokens,
            )
            return _strip_fences(response.choices[0].message.content or "").strip()
        except Exception as exc:
            last_error = exc
            attempt += 1
            if attempt > retries:
                break
            time.sleep(backoff * (2 ** (attempt - 1)) * (0.7 + 0.6 * random.random()))
    raise RuntimeError(f"LLM call failed after {retries + 1} attempts: {last_error}")


def call_chat_json(
    system: str,
    user: str,
    *,
    retries: int = 3,
    backoff: float = 1.5,
    timeout: float = 120.0,
    temperature: float = 0.2,
    max_tokens: int = 65536,
) -> Any:
    cfg = llm_config()
    if cfg is None:
        raise RuntimeError("LLM is not configured (LEXICON_LLM_BASE_URL/API_KEY/MODEL).")

    from openai import OpenAI

    client = OpenAI(base_url=cfg["base_url"], api_key=cfg["api_key"])
    last_error: Exception | None = None
    attempt = 0
    while attempt <= retries:
        try:
            response = client.chat.completions.create(
                model=cfg["model"],
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=temperature,
                timeout=timeout,
                max_tokens=max_tokens,
            )
            content = (response.choices[0].message.content or "").strip()
            return json.loads(_strip_fences(content))
        except Exception as exc:
            last_error = exc
            attempt += 1
            if attempt > retries:
                break
            time.sleep(backoff * (2 ** (attempt - 1)) * (0.7 + 0.6 * random.random()))
    raise RuntimeError(f"LLM call failed after {retries + 1} attempts: {last_error}")
