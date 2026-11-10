#!/bin/bash
# M1 final chain (post-fix): complete drills/phonetics, recover raw responses,
# re-export + sync mobile data, and rebuild the signed release APK so the
# shipped binary carries the finished dataset. Resumable: every step is
# idempotent (SQLite upserts + shard progress DB).
#
# Prereqs: same as scripts/build_release_apk.sh (JDK 21, Android SDK, node_modules).
# Usage: bash scripts/run_m1_final.sh
set -uo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=.
PY="${PY:-/opt/homebrew/bin/python3.11}"
LOG="out/m1_final.log"

echo "=== M1 final $(date) ===" >> "$LOG"

# 1. Fill remaining drills with the fixed parser (tolerates
#    CONCEPT_ID!tense/polarity keys) and fixed _limited (503 Unavailable
#    -> backoff + deterministic offline fallback instead of split-fail).
"$PY" -u -m dict_factory offline-fill --what drills --workers 8 --patience 1800 >> "$LOG" 2>&1

# 2. Offline recovery: re-parse everything saved under out/offline_raw.
"$PY" -u -m dict_factory offline-fill --replay-raw >> "$LOG" 2>&1

# 3. Phonetics (LLM-only, no safe offline synthesis) — retry what failed.
"$PY" -u -m dict_factory offline-fill --what phonetics --workers 8 --patience 1800 >> "$LOG" 2>&1
"$PY" -u -m dict_factory offline-fill --what phonetics --workers 4 --patience 1800 --resume-failed >> "$LOG" 2>&1

# 4. Report the final data-plane state.
"$PY" - <<'EOF' >> "$LOG" 2>&1
import sqlite3
c = sqlite3.connect('file:out/warehouse.db?mode=ro', uri=True)
dr = c.execute("SELECT COUNT(DISTINCT concept_id) FROM sentence_drills WHERE topic='business'").fetchone()[0]
ph = c.execute("SELECT COUNT(DISTINCT concept_id) FROM phonetics_text").fetchone()[0]
al = c.execute("SELECT COUNT(DISTINCT concept_id) FROM aligned_examples").fetchone()[0]
tot = c.execute("SELECT COUNT(*) FROM concepts").fetchone()[0]
print(f"DATA-STATE: concepts={tot} aligned={al}/12000 drills={dr}/12000 phonetics={ph}/12000")
f = sqlite3.connect('file:out/offline_fill.db?mode=ro', uri=True)
for row in f.execute("SELECT kind, status, COUNT(*) FROM shards GROUP BY 1,2"):
    print("shards:", row)
EOF

# 5. Ship it: export -> sync -> signed R8 release APK.
"$PY" -m dict_factory.export_mobile >> "$LOG" 2>&1
bash scripts/sync_mobile_data.sh >> "$LOG" 2>&1
if bash scripts/build_release_apk.sh >> "$LOG" 2>&1; then
  echo "=== M1 final DONE $(date) ===" >> "$LOG"
else
  echo "=== M1 final: APK build failed, see log $(date) ===" >> "$LOG"
  exit 1
fi
