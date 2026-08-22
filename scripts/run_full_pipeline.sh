#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=.
PY="/Users/admin/Documents/big-data/.venv/bin/python"
LOG="out/generate.log"
mkdir -p out
echo "=== syllabus $(date) ===" >> "$LOG"
"$PY" -u -m dict_factory syllabus --target 12000 --batch-size 120 >> "$LOG" 2>&1
echo "=== expressions $(date) ===" >> "$LOG"
"$PY" -u -m dict_factory expressions --batch-size 20 --workers 8 >> "$LOG" 2>&1
echo "=== warehouse $(date) ===" >> "$LOG"
"$PY" -u -m dict_factory warehouse >> "$LOG" 2>&1
echo "=== compile $(date) ===" >> "$LOG"
"$PY" -u -m dict_factory compile --sync-frontend >> "$LOG" 2>&1
echo "=== done $(date) ===" >> "$LOG"
