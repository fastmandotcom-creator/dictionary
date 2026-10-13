from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import pytest

from dict_factory.prompts import PROMPT_REGISTRY, load_prompt, prompt_messages


def test_all_prompts_have_schema_json() -> None:
    for name, (sys_md, user_md, schema_json) in PROMPT_REGISTRY.items():
        prompt = load_prompt(name, variables={
            "batch_size": 5,
            "start_rank": 1,
            "end_rank": 5,
            "target_cefr": "A1",
            "recent_ids": "",
            "recent_glosses": "",
            "created_total": 0,
            "target_langs": "en",
            "concepts_block": "- X | A1 | a",
            "target_lang": "ja",
            "base_lang": "vi",
            "units_block": "{}",
            "count": 1,
            "framework_code": "JLPT",
            "framework_lang": "ja",
            "framework_name": "JLPT",
            "source_tag": "community-estimate",
            "level_codes": "N5, N4",
            "mapping_table": "N5 | N5 | A1-A1",
            # drills pack prompt variables
            "concept_id": "X",
            "gloss_en": "a gloss",
            "en_surface": "x",
            "en_meaning": "a meaning",
            "pos": "verb",
            "cefr": "A1",
            "domain": "general",
            "topic": "general",
            "spec_block": "[]",
        })
        root = prompt.schema.get("type")
        if name == "drills":
            assert root == "object" and "sentences" in prompt.schema.get("properties", {}), \
                "drills schema must be an object with a sentences array"
        else:
            assert root == "array", f"{name} schema must be array"
        assert prompt.system, f"{name} system prompt empty"


def test_prompts_are_generic_no_hardcoded_pair() -> None:
    forbidden = re.compile(r"\b(vi->ja|ja->vi|vi→ja|ja→vi|Vietnamese.*Japanese|Japanese.*Vietnamese)\b", re.I)
    for name in PROMPT_REGISTRY:
        prompt = load_prompt(name, variables={
            "target_langs": "en", "concepts_block": "- X", "target_lang": "ja",
            "base_lang": "vi", "units_block": "{}", "count": 1,
            "batch_size": 1, "start_rank": 1, "end_rank": 1, "target_cefr": "A1",
            "recent_ids": "", "recent_glosses": "", "created_total": 0,
            "framework_code": "JLPT", "framework_lang": "ja", "framework_name": "JLPT",
            "source_tag": "community-estimate", "level_codes": "N5", "mapping_table": "N5 | N5 | A1-A1",
            # drills pack prompt variables
            "concept_id": "X", "gloss_en": "a gloss", "en_surface": "x",
            "en_meaning": "a meaning", "pos": "verb", "cefr": "A1",
            "domain": "general", "topic": "general", "spec_block": "[]",
        })
        text = prompt.system
        assert not forbidden.search(text), f"{name} system prompt hardcodes a language pair"


def test_prompt_messages_shape() -> None:
    messages = prompt_messages("examples_bilingual", variables={
        "target_lang": "es", "base_lang": "fr", "concepts_block": "- A | A1 | x", "count": 1,
    })
    assert len(messages) == 2
    assert messages[0]["role"] == "system"
    assert messages[1]["role"] == "user"
    assert "es" in messages[1]["content"]
    assert "fr" in messages[1]["content"]
