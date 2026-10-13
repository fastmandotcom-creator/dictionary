"""Client TTS ladder (srs.js) unit-tested in Node: server standard voice first,
browser floor fallback, source reporting."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
T = REPO / "dict_factory" / "templates"

_PREAMBLE = """
global.window = global;
global.localStorage = { _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; } };
global.URL = { createObjectURL: (b) => 'blob:' + String(b).slice(0, 12), revokeObjectURL: () => {} };
class FakeAudio {
  constructor(url) { this.url = url; this.played = false; this.play = () => { this.played = true; return Promise.resolve(); }; }
}
const fs = require('fs');
"""


def _run(script: str) -> dict:
    import json

    exe = shutil.which("node")
    if exe is None:
        raise AssertionError("node unavailable")
    proc = subprocess.run([exe, "-e", script], capture_output=True, text=True, cwd=REPO, timeout=60)
    if proc.returncode != 0:
        raise AssertionError(f"node failed:\n{proc.stdout}\n{proc.stderr}")
    return json.loads(proc.stdout)


def test_standard_voice_wins_when_api_ok() -> None:
    r = _run(_PREAMBLE + f"""
      let audioInstance = null;
      global.Audio = function (url) {{ audioInstance = new FakeAudio(url); return audioInstance; }};
      global.fetch = async (url) => {{
        if (!String(url).startsWith('/api/tts')) throw new Error('unexpected ' + url);
        return {{ ok: true, status: 200, blob: async () => 'STDAUDIO' }};
      }};
      eval(fs.readFileSync({str(T / 'srs.js')!r}, 'utf8'));
      const src = [];
      Srs.speak('hello world', 'en', (m) => src.push('notify:' + m), (s) => src.push('src:' + s));
      setTimeout(() => {{
        console.log(JSON.stringify({{
          source: Srs.ttsSource(),
          played: !!(audioInstance && audioInstance.played),
          audioUrl: audioInstance ? audioInstance.url : null,
          events: src,
        }}));
      }}, 50);
    """)
    assert r["source"] == "standard"
    assert r["played"] is True
    assert r["audioUrl"] and "STDAUDIO" in r["audioUrl"]
    assert "src:standard" in r["events"]
    assert not any(e.startswith("notify:") for e in r["events"])


def test_fallback_to_browser_when_api_down() -> None:
    r = _run(_PREAMBLE + f"""
      global.fetch = async () => ({{ ok: false, status: 503 }});
      let uttered = null;
      global.SpeechSynthesisUtterance = function (t) {{ this.text = t; }};
      global.window.speechSynthesis = {{
        getVoices: () => ([{{ lang: 'en-US', name: 'Fake' }}]),
        speak(u) {{ uttered = u; }},
      }};
      eval(fs.readFileSync({str(T / 'srs.js')!r}, 'utf8'));
      const src = [];
      Srs.speak('hello', 'en', () => src.push('notify'), (s) => src.push('src:' + s));
      setTimeout(() => {{
        console.log(JSON.stringify({{ source: Srs.ttsSource(), uttered: !!uttered, events: src }}));
      }}, 50);
    """)
    assert r["source"] == "browser"
    assert r["uttered"] is True
    assert "src:browser" in r["events"]


def test_none_when_api_down_and_no_browser_speech() -> None:
    r = _run(_PREAMBLE + f"""
      global.fetch = async () => ({{ ok: false, status: 503 }});
      let notified = null;
      eval(fs.readFileSync({str(T / 'srs.js')!r}, 'utf8'));
      Srs.speak('hello', 'en', (m) => {{ notified = m; }}, () => {{}});
      setTimeout(() => {{
        console.log(JSON.stringify({{ source: Srs.ttsSource(), notified: notified }}));
      }}, 50);
    """)
    assert r["source"] == "none"
    assert r["notified"]
