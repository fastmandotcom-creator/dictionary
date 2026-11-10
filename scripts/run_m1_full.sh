#!/bin/bash
# M1 full: complete 100% of 12k drills + phonetics.
# Fixed scheduler (per-model backoff + concurrency caps + deterministic
# drills fallback) makes this a single resumable run. Run when the gateway
# has quota; rerunning the same command resumes (done-shards are skipped,
# failed shards are replayed).
set -uo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=.
PY="${PY:-/opt/homebrew/bin/python3.11}"
LOG="out/offline_fill_m1.log"
echo "=== M1 full $(date) ===" >> "$LOG"
# priority = aligned(done) + drills first, then phonetics; 30-min patience
# per shard so drills fall back offline only when ALL models are over limit.
"$PY" -u -m dict_factory offline-fill --what drills --workers 8 --patience 1800 >> "$LOG" 2>&1
"$PY" -u -m dict_factory offline-fill --what phonetics --workers 8 --patience 1800 >> "$LOG" 2>&1
echo "=== M1 done $(date) ===" >> "$LOG"
# Re-replay anything still failed (transient splits) in a second pass.
"$PY" -u -m dict_factory offline-fill --what drills --workers 4 --patience 1800 --resume-failed >> "$LOG" 2>&1
"$PY" -u -m dict_factory offline-fill --what phonetics --workers 4 --patience 1800 --resume-failed >> "$LOG" 2>&1
echo "=== M1 resume-pass done $(date) ===" >> "$LOG"
