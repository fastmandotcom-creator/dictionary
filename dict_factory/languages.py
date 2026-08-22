# ISO 639-1 keys MUST match frontend SUPPORTED_LANGUAGES exactly.
# JSON output keys stay these codes. Names/regions are prompt-only.
LANGUAGE_SPECS: tuple[tuple[str, str, str, str], ...] = (
    ("en", "English", "English", "en"),
    ("zh", "Chinese (Simplified)", "中文（简体）", "zh-Hans"),
    ("hi", "Hindi", "हिन्दी", "hi-IN"),
    ("es", "Spanish", "Español", "es"),
    ("fr", "French", "Français", "fr"),
    ("ar", "Modern Standard Arabic", "العربية الفصحى", "ar"),
    ("bn", "Bengali", "বাংলা", "bn"),
    ("pt", "Portuguese (Brazil)", "Português (Brasil)", "pt-BR"),
    ("ru", "Russian", "Русский", "ru"),
    ("ur", "Urdu", "اردو", "ur"),
    ("id", "Indonesian", "Bahasa Indonesia", "id-ID"),
    ("de", "German", "Deutsch", "de"),
    ("ja", "Japanese", "日本語", "ja-JP"),
    ("sw", "Swahili", "Kiswahili", "sw"),
    ("te", "Telugu", "తెలుగు", "te-IN"),
    ("ta", "Tamil", "தமிழ்", "ta"),
    ("tr", "Turkish", "Türkçe", "tr-TR"),
    ("ko", "Korean", "한국어", "ko-KR"),
    ("vi", "Vietnamese", "Tiếng Việt", "vi-VN"),
    ("it", "Italian", "Italiano", "it"),
    ("th", "Thai", "ไทย", "th-TH"),
    ("pl", "Polish", "Polski", "pl"),
    ("uk", "Ukrainian", "Українська", "uk-UA"),
    ("ms", "Malay", "Bahasa Melayu", "ms-MY"),
    ("fa", "Persian (Farsi)", "فارسی", "fa-IR"),
    ("ro", "Romanian", "Română", "ro"),
    ("nl", "Dutch", "Nederlands", "nl"),
    ("el", "Greek", "Ελληνικά", "el"),
    ("cs", "Czech", "Čeština", "cs"),
    ("sv", "Swedish", "Svenska", "sv"),
    ("hu", "Hungarian", "Magyar", "hu"),
    ("he", "Hebrew", "עברית", "he-IL"),
    ("no", "Norwegian", "Norsk", "nb-NO"),
    ("da", "Danish", "Dansk", "da"),
    ("fi", "Finnish", "Suomi", "fi"),
)

LANGUAGES: tuple[str, ...] = tuple(code for code, _name, _native, _tag in LANGUAGE_SPECS)


def language_prompt_block() -> str:
    lines = [
        f"Languages ({len(LANGUAGE_SPECS)}). JSON keys MUST be the ISO 639-1 code exactly:",
    ]
    for code, name, native, tag in LANGUAGE_SPECS:
        extra = ""
        if code == "id":
            extra = " — key is Indonesian, NOT English 'id'"
        elif code == "pt":
            extra = " — Brazil, NOT Portugal"
        elif code == "zh":
            extra = " — Simplified, NOT Traditional"
        elif code == "ms":
            extra = " — Malay, NOT Indonesian"
        lines.append(f"- {code} | {name} | {native} | {tag}{extra}")
    return "\n".join(lines)


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
