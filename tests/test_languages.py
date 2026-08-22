from dict_factory.languages import LANGUAGES, LANGUAGE_SPECS, language_prompt_block


def test_language_codes_match_extension_order_and_count() -> None:
    assert len(LANGUAGES) == 35
    assert LANGUAGES[0] == "en"
    assert "id" in LANGUAGES
    assert [spec[0] for spec in LANGUAGE_SPECS] == list(LANGUAGES)


def test_prompt_names_iso_and_regions() -> None:
    block = language_prompt_block()
    assert "pt | Portuguese (Brazil)" in block
    assert "id | Indonesian" in block
    assert "zh | Chinese (Simplified)" in block
    assert "pt-BR" in block
    assert "zh-Hans" in block
    for code in LANGUAGES:
        assert f"- {code} |" in block
