CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  cefr TEXT NOT NULL CHECK (cefr IN ('A1','A2','B1','B2','C1')),
  pos TEXT NOT NULL CHECK (pos IN ('noun','verb','adjective','adverb','phrase','other')),
  gloss_en TEXT NOT NULL,
  rank INTEGER NOT NULL UNIQUE CHECK (rank >= 1)
);
CREATE TABLE IF NOT EXISTS expressions (
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  expression_type TEXT NOT NULL,
  meaning TEXT NOT NULL,
  PRIMARY KEY (concept_id, lang)
);
CREATE TABLE IF NOT EXISTS examples (
  id INTEGER PRIMARY KEY,
  concept_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  sentence TEXT NOT NULL,
  UNIQUE (concept_id, lang)
);
CREATE TABLE IF NOT EXISTS phonetics_text (
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  lang TEXT NOT NULL,
  romaji TEXT NOT NULL,
  ipa TEXT NOT NULL,
  prompt_v TEXT NOT NULL DEFAULT 'v1',
  PRIMARY KEY (concept_id, lang)
);
CREATE TABLE IF NOT EXISTS examples_bilingual (
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  lang_target TEXT NOT NULL,
  lang_base TEXT NOT NULL,
  sent_target TEXT NOT NULL,
  sent_base TEXT NOT NULL,
  prompt_v TEXT NOT NULL DEFAULT 'v1',
  UNIQUE (concept_id, lang_target, lang_base)
);
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  cefr TEXT NOT NULL CHECK (cefr IN ('A1','A2','B1','B2','C1')),
  order_no INTEGER NOT NULL,
  title_json TEXT NOT NULL,
  prompt_v TEXT NOT NULL DEFAULT 'v1',
  UNIQUE (target, cefr, order_no)
);
CREATE TABLE IF NOT EXISTS unit_items (
  unit_id TEXT NOT NULL REFERENCES units(id),
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  order_no INTEGER NOT NULL,
  prompt_v TEXT NOT NULL DEFAULT 'v1',
  PRIMARY KEY (unit_id, concept_id)
);
CREATE INDEX IF NOT EXISTS idx_examples_bilingual_pair ON examples_bilingual(lang_target, lang_base);
CREATE INDEX IF NOT EXISTS idx_units_lookup ON units(target, cefr, order_no);
CREATE INDEX IF NOT EXISTS idx_unit_items_unit ON unit_items(unit_id);
CREATE INDEX IF NOT EXISTS idx_examples_bilingual_concept ON examples_bilingual(concept_id);
CREATE TABLE IF NOT EXISTS exam_framework (
  code TEXT PRIMARY KEY,
  lang TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS exam_level (
  framework TEXT NOT NULL REFERENCES exam_framework(code),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  cefr_lo TEXT NOT NULL CHECK (cefr_lo IN ('A1','A2','B1','B2','C1')),
  cefr_hi TEXT NOT NULL CHECK (cefr_hi IN ('A1','A2','B1','B2','C1')),
  sort_no INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'community-estimate',
  prompt_v TEXT NOT NULL DEFAULT 'v1',
  PRIMARY KEY (framework, code)
);
CREATE INDEX IF NOT EXISTS idx_exam_level_framework ON exam_level(framework, sort_no);
-- Advanced listen-and-write drills (Phase D1). One row per
-- (concept, target_lang, topic, drill_key); drill_key = "tense/polarity".
-- Meaning stays anchored to gloss_en: the pack is generated per concept+topic
-- and cached here so repeat learners never pay for it again.
CREATE TABLE IF NOT EXISTS sentence_drills (
  id INTEGER PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  target_lang TEXT NOT NULL,
  topic TEXT NOT NULL,
  drill_key TEXT NOT NULL,
  tense TEXT NOT NULL,
  polarity TEXT NOT NULL,
  sentence TEXT NOT NULL,
  surface TEXT NOT NULL,
  base_hint TEXT,
  prompt_v TEXT NOT NULL DEFAULT 'v1',
  created_at TEXT NOT NULL,
  UNIQUE (concept_id, target_lang, topic, drill_key)
);
CREATE INDEX IF NOT EXISTS idx_sentence_drills_lookup ON sentence_drills(concept_id, target_lang, topic);
