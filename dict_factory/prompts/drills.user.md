Concept: {concept_id}
English gloss (the meaning to keep): {gloss_en}
English surface expression: {en_surface}
English part of speech: {pos}
CEFR level: {cefr}
Domain: {domain}
Drill context topic: {topic}
Learner base language (for optional base_hint): {base_lang}
Target language to write: {target_lang}

Write exactly one sentence for EACH drill spec below ({count} specs):
{spec_block}

Return ONLY the JSON object with a "sentences" array, one item per spec,
same order, each with: drill_key, tense, polarity, sentence, surface, base_hint.
