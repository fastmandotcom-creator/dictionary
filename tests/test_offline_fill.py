from __future__ import annotations

from dict_factory.db import connect, init_schema
from dict_factory.languages import LANGUAGES
from dict_factory.learn_queries import learn_concept_pair
from dict_factory.offline_fill import parse_aligned, parse_drills, parse_phonetics


def test_parse_aligned_keeps_complete_rows_only() -> None:
    row = ["GREET_HELLO"] + [f"s-{lang}" for lang in LANGUAGES]
    short = ["WATER", "only-one"]
    got = parse_aligned({"rows": [row, short]}, {"GREET_HELLO", "WATER"})
    assert set(got) == {"GREET_HELLO"}
    assert got["GREET_HELLO"]["vi"] == "s-vi"
    assert len(got["GREET_HELLO"]) == 35


def test_parse_phonetics_rejects_non_ascii_romanization() -> None:
    bad = ["GREET_HELLO"]
    for lang in LANGUAGES:
        bad.extend(["xin chào" if lang == "vi" else "hello", "/həˈloʊ/"])
    good = ["WATER"]
    for _lang in LANGUAGES:
        good.extend(["nuoc", "/nuk/"])
    got = parse_phonetics({"rows": [bad, good]}, {"GREET_HELLO", "WATER"})
    assert set(got) == {"WATER"}
    assert got["WATER"]["en"] == ("nuoc", "/nuk/")


def test_parse_drills_uses_pos_matrix() -> None:
    concept = {"id": "EAT_FOOD", "pos": "verb", "gloss_en": "to eat"}
    sentences = []
    for tense in ("present_simple", "past_simple", "future_simple"):
        for polarity in ("affirmative", "negative", "question"):
            end = "?" if polarity == "question" else "."
            sentences.append({
                "drill_key": f"{tense}/{polarity}",
                "tense": tense,
                "polarity": polarity,
                "sentence": f"Do you eat at the office{end}" if polarity == "question" else f"I eat at the office{end}",
                "surface": "eat",
                "base_hint": "ăn ở công sở",
            })
    got = parse_drills({"packs": [{"id": "EAT_FOOD", "sentences": sentences}]}, [concept])
    assert len(got["EAT_FOOD"]) == 9


def test_aligned_examples_fill_bilingual_card(tmp_path) -> None:
    conn = connect(tmp_path / "t.db")
    init_schema(conn)
    conn.execute(
        "INSERT INTO concepts (id, domain, cefr, pos, gloss_en, rank) VALUES (?,?,?,?,?,?)",
        ("GREET_HELLO", "general", "A1", "verb", "to greet", 1),
    )
    conn.execute(
        "INSERT INTO expressions (concept_id, lang, text, expression_type, meaning) VALUES (?,?,?,?,?)",
        ("GREET_HELLO", "en", "hello", "word", "to greet"),
    )
    conn.execute(
        "INSERT INTO expressions (concept_id, lang, text, expression_type, meaning) VALUES (?,?,?,?,?)",
        ("GREET_HELLO", "vi", "xin chào", "word", "to greet"),
    )
    conn.execute(
        "INSERT INTO aligned_examples (concept_id, lang, sentence, prompt_v) VALUES (?,?,?,?)",
        ("GREET_HELLO", "en", "I greet the client.", "v1"),
    )
    conn.execute(
        "INSERT INTO aligned_examples (concept_id, lang, sentence, prompt_v) VALUES (?,?,?,?)",
        ("GREET_HELLO", "vi", "Tôi chào khách.", "v1"),
    )
    conn.commit()
    detail = learn_concept_pair(conn, "GREET_HELLO", "vi", "en")
    assert detail["bilingual"]["sent_target"] == "I greet the client."
    assert detail["bilingual"]["sent_base"] == "Tôi chào khách."
    conn.close()
