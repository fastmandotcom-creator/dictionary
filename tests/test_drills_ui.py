"""Client-side drill logic (drills.js) unit-tested in Node (no browser)."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
T = REPO / "dict_factory" / "templates"


def _run_node(script: str) -> dict:
    exe = shutil.which("node")
    if exe is None:
        return {"skipped": True}
    proc = subprocess.run(
        [exe, "-e", script],
        capture_output=True, text=True, cwd=REPO, timeout=60,
    )
    if proc.returncode != 0:
        raise AssertionError(f"node failed:\n{proc.stdout}\n{proc.stderr}")
    return json.loads(proc.stdout)


def test_normalize_and_srs_id() -> None:
    r = _run_node(f"""
      global.window = global;
      global.localStorage = {{ _s: {{}},
        getItem(k) {{ return this._s[k] ?? null; }},
        setItem(k, v) {{ this._s[k] = String(v); }},
        removeItem(k) {{ delete this._s[k]; }} }};
      const fs = require('fs');
      eval(fs.readFileSync({str(T / 'srs.js')!r}, 'utf8'));
      eval(fs.readFileSync({str(T / 'drills.js')!r}, 'utf8'));
      console.log(JSON.stringify({{
        norm: DrillUI.normalize('  Hello   WORLD? '),
        id: DrillUI.srsId('C', 'past_simple/negative'),
      }}));
    """)
    if r.get("skipped"):
        raise AssertionError("node unavailable")
    assert r["norm"] == "hello world?"
    assert r["id"] == "C::past_simple/negative"


def test_demo_pack_matrix_by_pos() -> None:
    r = _run_node(f"""
      global.window = global;
      global.localStorage = {{ _s: {{}},
        getItem(k) {{ return this._s[k] ?? null; }},
        setItem(k, v) {{ this._s[k] = String(v); }},
        removeItem(k) {{ delete this._s[k]; }} }};
      const fs = require('fs');
      eval(fs.readFileSync({str(T / 'srs.js')!r}, 'utf8'));
      eval(fs.readFileSync({str(T / 'drills.js')!r}, 'utf8'));
      const verb = DrillUI.demoPack({{ id: 'EAT_FOOD', en: 'to eat', gloss: 'ăn', pos: 'verb' }}, 'business');
      const noun = DrillUI.demoPack({{ id: 'WATER', en: 'water', gloss: 'nước', pos: 'noun' }}, 'general');
      const vkeys = verb.map(d => d.drill_key);
      console.log(JSON.stringify({{
        verbCount: verb.length,
        hasFutureQuestion: vkeys.includes('future_simple/question'),
        verbNoToPrefix: !verb[0].sentence.toLowerCase().includes('to eat') && verb[0].surface === 'eat',
        pastUsesIrregular: verb.find(d => d.drill_key === 'past_simple/affirmative').sentence.includes('ate'),
        nounCount: noun.length,
        nounKeys: noun.map(d => d.drill_key),
        demoFlag: verb[0].demo === true,
      }}));
    """)
    if r.get("skipped"):
        raise AssertionError("node unavailable")
    assert r["verbCount"] == 9
    assert r["hasFutureQuestion"] is True
    assert r["verbNoToPrefix"] is True
    assert r["pastUsesIrregular"] is True
    assert r["nounCount"] == 3
    assert r["nounKeys"] == ["present_simple/affirmative", "present_simple/negative", "present_simple/question"]
    assert r["demoFlag"] is True


def test_pick_drill_key_prefers_due() -> None:
    r2 = _run_node(f"""
      global.window = global;
      const store = {{ _s: {{}},
        getItem(k) {{ return this._s[k] ?? null; }},
        setItem(k, v) {{ this._s[k] = String(v); }},
        removeItem(k) {{ delete this._s[k]; }} }};
      global.localStorage = store;
      const fs = require('fs');
      eval(fs.readFileSync({str(T / 'srs.js')!r}, 'utf8'));
      eval(fs.readFileSync({str(T / 'drills.js')!r}, 'utf8'));
      const srsKey = Srs.srsKey('vi', 'en');
      const srs = JSON.parse(localStorage.getItem(srsKey) || '{{}}');
      srs['C::past_simple/negative'] = {{ grade: 'hard', due: Srs.isoFromOffset(-1), updated_at: Date.now() }};
      localStorage.setItem(srsKey, JSON.stringify(srs));
      const drills = [
        {{ drill_key: 'present_simple/affirmative' }},
        {{ drill_key: 'past_simple/negative' }},
      ];
      console.log(JSON.stringify({{ pick: DrillUI.pickDrillKey('C', drills, 'vi', 'en') }}));
    """)
    if r2.get("skipped"):
        raise AssertionError("node unavailable")
    # the due drill (past_simple/negative) must win even though the ungraded one comes first
    assert r2["pick"] == "past_simple/negative"
