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
