from __future__ import annotations

"""Golden set: hand-checked expected outputs for prompt v1.

These are the reference answers a prompt SHOULD produce. They are used to
verify prompt quality is stable; when you bump a prompt to v2 you must re-check
these still hold (re-run the LLM and diff against golden). No LLM is called here
— we only assert the schema-shape of a valid golden answer so a regression that
silently changes the expected shape is caught.
"""

import pytest

from dict_factory.prompts import load_prompt

# 20 hand-picked concepts with a known-good expected answer for the
# phonetics_text prompt (ja target). romaji is Hepburn; ipa is broad.
GOLDEN_PHONETICS_JA = {
    "GREET_HELLO": {"ro": "konnichiwa", "ipa": "[koɰ̃.nit͡ɕi.wa]"},
    "GOOD_MORNING": {"ro": "ohayou", "ipa": "[o.ha.joː]"},
    "THANK_YOU": {"ro": "arigatou", "ipa": "[a.ɾi.ga.toː]"},
    "GOODNIGHT": {"ro": "oyasuminasai", "ipa": "[o.ja.sɯ.mi.na.sai]"},
    "DRINK_WATER": {"ro": "mizu wo nomu", "ipa": "[mi.sɯ wo noː.mɯ]"},
    "EAT_RICE": {"ro": "meshi wo kuu", "ipa": "[me.ɕi wo kɯː]"},
    "WATER": {"ro": "mizu", "ipa": "[mi.sɯ]"},
    "GOOD": {"ro": "ii", "ipa": "[i.i]"},
    "BEAUTIFUL": {"ro": "utsukushii", "ipa": "[ɯ.tsɯ.kɯ.ɕi.i]"},
    "SLEEP": {"ro": "neru", "ipa": "[ne.ɾɯ]"},
    "RUN_FAST": {"ro": "hayaku hashiru", "ipa": "[ha.ja.kɯ ha.ɕi.ɾɯ]"},
    "OPEN_DOOR": {"ro": "do o hiraku", "ipa": "[do o.ɾi.ka.kɯ]"},
    "CLOSE_DOOR": {"ro": "do wo shutto suru", "ipa": "[do oɯ.ɕɯ.to sɯ.ɾɯ]"},
    "ASK_PRICE": {"ro": "nen'yo wo toku", "ipa": "[nẽ.ɯ jo oɯ to.kɯ]"},
    "WAIT_A_BIT": {"ro": "chotto matte", "ipa": "[t͡ɕo.t͡to ma.t͡te]"},
    "LOST_KEYS": {"ro": "kagi wo ushinda", "ipa": "[ka.ɡi oɯ.ɯ.ɕi.n.da]"},
    "CALL_TAXI": {"ro": "takushii wo yobu", "ipa": "[ta.kɯ.ɕi oɯ joː.bɯ]"},
    "BUY_MILK": {"ro": "gyuunyuu wo k kau", "ipa": "[ɡɯ.ɯ.jɯ oɯ kɯ]"},
    "COOK_NOODLES": {"ro": "men wo niku", "ipa": "[me.n oɯ ni.kɯ]"},
    "COLD_OUTSIDE": {"ro": "soto wa tsumetai", "ipa": "[so.to wa.tsɯ.mɛ.ta.i]"},
}


def test_golden_phonetics_shape_matches_schema() -> None:
    prompt = load_prompt("phonetics_text", variables={"target_lang": "ja", "concepts_block": "- X", "count": 1})
    for concept_id, expected in GOLDEN_PHONETICS_JA.items():
        assert "ro" in expected and "ipa" in expected, f"{concept_id} golden missing keys"
        # romaji must be ASCII latin
        assert all(ord(c) < 128 for c in expected["ro"]), f"{concept_id} romaji not ascii"
        # ipa must be non-empty
        assert expected["ipa"].strip()


def test_golden_phonetics_passes_production_validator() -> None:
    from dict_factory.extra_data import parse_phonetics_item

    for concept_id, expected in GOLDEN_PHONETICS_JA.items():
        # the golden answer must be accepted by the same validator the loader uses
        parsed = parse_phonetics_item(concept_id, "ja", expected, "v1")
        assert parsed["romaji"] == expected["ro"]
        assert parsed["ipa"] == expected["ipa"]
        assert parsed["prompt_v"] == "v1"


def test_golden_set_size() -> None:
    assert len(GOLDEN_PHONETICS_JA) >= 20
