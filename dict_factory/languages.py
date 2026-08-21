LANGUAGES: tuple[str, ...] = (
    "en",
    "zh",
    "hi",
    "es",
    "fr",
    "ar",
    "bn",
    "pt",
    "ru",
    "ur",
    "id",
    "de",
    "ja",
    "sw",
    "te",
    "ta",
    "tr",
    "ko",
    "vi",
    "it",
    "th",
    "pl",
    "uk",
    "ms",
    "fa",
    "ro",
    "nl",
    "el",
    "cs",
    "sv",
    "hu",
    "he",
    "no",
    "da",
    "fi",
)

CEFR_LEVELS = frozenset({"A1", "A2", "B1", "B2", "C1"})
POS_VALUES = frozenset({"noun", "verb", "adjective", "adverb", "phrase", "other"})
CONCEPT_ID_PATTERN = r"^[A-Z][A-Z0-9_]+$"
MAX_EXPRESSION_CHARS = 80
PHRASE_TYPES = frozenset(
    {
        "collocation",
        "idiom",
        "verb_expression",
        "phrasal_verb",
        "compound_verb",
        "fixed_expression",
        "sentence_pattern",
        "phrase",
    }
)
