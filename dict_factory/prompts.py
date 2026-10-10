from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dict_factory.languages import language_prompt_block

PROMPT_DIR = Path(__file__).resolve().parent / "prompts"

# prompt name -> (system.md, user.md, schema.json)
PROMPT_REGISTRY: dict[str, tuple[str, str, str]] = {
    "syllabus": ("syllabus.system.md", "syllabus.user.md", "syllabus.schema.json"),
    "expressions": ("expressions.system.md", "expressions.user.md", "expressions.schema.json"),
    "phonetics_text": ("phonetics.system.md", "phonetics.user.md", "phonetics.schema.json"),
    "examples_bilingual": ("examples_bilingual.system.md", "examples_bilingual.user.md", "examples_bilingual.schema.json"),
    "examples_monolingual": ("examples_monolingual.system.md", "examples_monolingual.user.md", "examples_monolingual.schema.json"),
    "units_title": ("units_title.system.md", "units_title.user.md", "units_title.schema.json"),
    "exam_levels": ("exam_levels.system.md", "exam_levels.user.md", "exam_levels.schema.json"),
}

# aliases so callers can use the shorter table name
PROMPT_ALIASES: dict[str, str] = {"phonetics": "phonetics_text"}


@dataclass(frozen=True)
class Prompt:
    name: str
    version: str
    system: str
    user: str
    schema: dict


def _read(relative: str) -> str:
    return (PROMPT_DIR / relative).read_text(encoding="utf-8").strip()


def _render(template: str, variables: dict[str, object]) -> str:
    return template.format(**variables)


def load_prompt(name: str, *, version: str = "v1", variables: dict[str, object] | None = None) -> Prompt:
    name = PROMPT_ALIASES.get(name, name)
    if name not in PROMPT_REGISTRY:
        raise KeyError(f"unknown prompt {name!r}; known: {sorted(PROMPT_REGISTRY)}")
    sys_path, user_path, schema_path = PROMPT_REGISTRY[name]
    variables = dict(variables or {})
    if "lang_block" not in variables:
        variables["lang_block"] = language_prompt_block()
    schema = json.loads(_read(schema_path))
    return Prompt(
        name=name,
        version=version,
        system=_read(sys_path),
        user=_render(_read(user_path), variables),
        schema=schema,
    )


def render_prompt(name: str, *, version: str = "v1", variables: dict[str, object] | None = None) -> tuple[str, str]:
    prompt = load_prompt(name, version=version, variables=variables)
    return prompt.system, prompt.user


def prompt_messages(name: str, *, version: str = "v1", variables: dict[str, object] | None = None) -> list[dict[str, str]]:
    system, user = render_prompt(name, version=version, variables=variables)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def estimate_tokens(system: str, user: str) -> int:
    return max(1, (len(system) + len(user)) // 4)


class SchemaViolation(ValueError):
    pass


def _check_type(value: Any, want: str, path: str) -> None:
    ok = (
        (want == "array" and isinstance(value, list))
        or (want == "object" and isinstance(value, dict))
        or (want == "string" and isinstance(value, str))
        or (want == "integer" and isinstance(value, int) and not isinstance(value, bool))
        or (want == "number" and isinstance(value, (int, float)) and not isinstance(value, bool))
        or (want == "boolean" and isinstance(value, bool))
        or (want == "null" and value is None)
    )
    if not ok:
        raise SchemaViolation(f"{path or '$'}: expected {want}, got {type(value).__name__}")


def _check_schema(value: Any, schema: dict, path: str) -> None:
    want = schema.get("type")
    if isinstance(want, list):
        if not any(_is_type(value, t) for t in want):
            raise SchemaViolation(f"{path or '$'}: expected one of {want}")
    elif isinstance(want, str):
        _check_type(value, want, path)
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            raise SchemaViolation(f"{path}: shorter than minLength {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise SchemaViolation(f"{path}: longer than maxLength {schema['maxLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise SchemaViolation(f"{path}: does not match pattern {schema['pattern']!r}")
        if "enum" in schema and value not in schema["enum"]:
            raise SchemaViolation(f"{path}: {value!r} not in enum")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            raise SchemaViolation(f"{path}: below minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise SchemaViolation(f"{path}: above maximum {schema['maximum']}")
        if "enum" in schema and value not in schema["enum"]:
            raise SchemaViolation(f"{path}: {value!r} not in enum")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            raise SchemaViolation(f"{path or '$'}: fewer than minItems {schema['minItems']}")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise SchemaViolation(f"{path or '$'}: more than maxItems {schema['maxItems']}")
        sub = schema.get("items")
        if isinstance(sub, dict):
            for i, item in enumerate(value):
                _check_schema(item, sub, f"{path or '$'}[{i}]")
    if isinstance(value, dict):
        if "minProperties" in schema and len(value) < schema["minProperties"]:
            raise SchemaViolation(f"{path or '$'}: fewer than minProperties {schema['minProperties']}")
        if "maxProperties" in schema and len(value) > schema["maxProperties"]:
            raise SchemaViolation(f"{path or '$'}: more than maxProperties {schema['maxProperties']}")
        for key in schema.get("required", []):
            if key not in value:
                raise SchemaViolation(f"{path or '$'}: missing required key {key!r}")
        props = schema.get("properties", {})
        extra = schema.get("additionalProperties")
        for key, item in value.items():
            if key in props:
                _check_schema(item, props[key], f"{path or '$'}.{key}")
            elif isinstance(extra, dict):
                _check_schema(item, extra, f"{path or '$'}.{key}")
            elif extra is False:
                raise SchemaViolation(f"{path or '$'}: unexpected key {key!r}")


def _is_type(value: Any, want: str) -> bool:
    try:
        _check_type(value, want, "$")
        return True
    except SchemaViolation:
        return False


def validate_payload(name: str, payload: Any) -> Any:
    """Enforce the registered JSON schema for a prompt. Returns payload unchanged.

    Raises SchemaViolation on any mismatch. Zero third-party dependencies.
    """
    sys_path, user_path, schema_path = PROMPT_REGISTRY[PROMPT_ALIASES.get(name, name)]
    schema = json.loads(_read(schema_path))
    _check_schema(payload, schema, "$")
    return payload
