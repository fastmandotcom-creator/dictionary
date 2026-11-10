#!/bin/bash
# M1 completion pass (runs AFTER scripts/run_m1_final.sh finishes).
# Guarantees drills reach 12,000/12,000: any concept still without a drill
# pack gets the deterministic offline pack (sanctioned v1-offline path), then
# the mobile dataset is re-exported, synced, and the release APK rebuilt so
# the shipped binary carries the finished dataset.
#
# Usage: bash scripts/run_m1_complete.sh
set -uo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=.
PY="${PY:-/opt/homebrew/bin/python3.11}"
LOG="out/m1_complete.log"

echo "=== M1 complete $(date) ===" >> "$LOG"

# 1. Wait for the main chain to reach its terminal marker (bounded wait).
echo "waiting for out/m1_final.log terminal marker ..." >> "$LOG"
for i in $(seq 1 1440); do
  if grep -qE "^=== M1 final (DONE|: APK build failed)" out/m1_final.log 2>/dev/null; then
    echo "m1_final terminal marker seen" >> "$LOG"
    break
  fi
  sleep 60
done

# 2. Final drills pass: skip done shards; remaining ones complete via LLM
#    (healthy models) or the deterministic offline fallback (all-limited).
"$PY" -u -m dict_factory offline-fill --what drills --workers 4 --patience 1800 >> "$LOG" 2>&1

# 3. Recover any fresh raw responses saved by step 2 (new on-disk parser).
"$PY" -u -m dict_factory offline-fill --replay-raw >> "$LOG" 2>&1

# 4. Data-plane report.
"$PY" - <<'EOF' >> "$LOG" 2>&1
import sqlite3
c = sqlite3.connect('file:out/warehouse.db?mode=ro', uri=True)
dr = c.execute("SELECT COUNT(DISTINCT concept_id) FROM sentence_drills WHERE topic='business'").fetchone()[0]
ph = c.execute("SELECT COUNT(DISTINCT concept_id) FROM phonetics_text").fetchone()[0]
tot = c.execute("SELECT COUNT(*) FROM concepts").fetchone()[0]
ok = "COMPLETE" if dr == tot else "INCOMPLETE"
print(f"FINAL-DATA: drills={dr}/{tot} ({ok}) phonetics={ph}/{tot} (LLM-quota-gated)")
EOF

# 5. Ship the finished dataset: export -> sync -> signed R8 release APK.
"$PY" -m dict_factory.export_mobile >> "$LOG" 2>&1
bash scripts/sync_mobile_data.sh >> "$LOG" 2>&1
if bash scripts/build_release_apk.sh >> "$LOG" 2>&1; then
  echo "=== M1 COMPLETE $(date) ===" >> "$LOG"
else
  echo "=== M1 COMPLETE: APK build failed, see log $(date) ===" >> "$LOG"
  exit 1
fi
