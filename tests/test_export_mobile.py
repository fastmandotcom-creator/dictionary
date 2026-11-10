from __future__ import annotations

import json
import sqlite3

from dict_factory.export_mobile import export_pack


def test_export_pack_writes_lang_files(tmp_path) -> None:
    src = tmp_path / "src.db"
    conn = sqlite3.connect(src)
    conn.execute("CREATE TABLE concepts (id TEXT, cefr TEXT, pos TEXT, gloss_en TEXT, rank INTEGER)")
    conn.execute("INSERT INTO concepts VALUES ('GREET_HELLO','A1','verb','to greet',1)")
    conn.execute("CREATE TABLE expressions (concept_id TEXT, lang TEXT, text TEXT)")
    conn.execute("INSERT INTO expressions VALUES ('GREET_HELLO','en','hello')")
    conn.execute("INSERT INTO expressions VALUES ('GREET_HELLO','vi','xin chào')")
    conn.execute("CREATE TABLE aligned_examples (concept_id TEXT, lang TEXT, sentence TEXT)")
    conn.execute("INSERT INTO aligned_examples VALUES ('GREET_HELLO','vi','Xin chào bạn.')")
    conn.execute(
        "CREATE TABLE sentence_drills (concept_id TEXT, target_lang TEXT, topic TEXT, drill_key TEXT, sentence TEXT, surface TEXT, base_hint TEXT, tense TEXT, polarity TEXT)"
    )
    conn.execute(
        "INSERT INTO sentence_drills VALUES ('GREET_HELLO','en','business','present_simple/affirmative','I greet the client.','greet','chào khách','present_simple','affirmative')"
    )
    conn.commit()
    conn.close()

    dest = export_pack(src, tmp_path / "www")
    concepts = json.loads((dest / "concepts.json").read_text())
    vi = json.loads((dest / "lang" / "vi.json").read_text())
    drills = json.loads((dest / "drills.json").read_text())
    assert concepts == ["GREET_HELLO"]
    assert vi["w"]["GREET_HELLO"] == "xin chào"
    assert vi["e"]["GREET_HELLO"] == "Xin chào bạn."
    assert drills["GREET_HELLO"][0]["s"] == "I greet the client."
    assert drills["GREET_HELLO"][0]["t"] == "present_simple"
    assert drills["GREET_HELLO"][0]["p"] == "affirmative"
    assert drills["GREET_HELLO"][0]["sf"] == "greet"
