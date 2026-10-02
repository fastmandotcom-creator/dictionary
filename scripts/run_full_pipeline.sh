#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=.
PY="${PY:-${PYTHON:-python3}}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "error: python not found (set PY=... to override)" >&2
  exit 1
fi
LOG="out/generate.log"
mkdir -p out
echo "=== syllabus $(date) ===" >> "$LOG"
"$PY" -u -m dict_factory syllabus --target 12000 --batch-size 120 >> "$LOG" 2>&1
echo "=== expressions $(date) ===" >> "$LOG"
"$PY" -u -m dict_factory expressions --batch-size 20 --workers 8 >> "$LOG" 2>&1
echo "=== warehouse $(date) ===" >> "$LOG"
"$PY" -u -m dict_factory warehouse >> "$LOG" 2>&1
# Learn-data plane: dry-run only by default; plug LEXICON_LLM_* and drop --dry-run to fill.
echo "=== fill (dry-run) $(date) ===" >> "$LOG"
"$PY" -u -m dict_factory fill --what phonetics --target ja --limit 40 --dry-run >> "$LOG" 2>&1 || true
"$PY" -u -m dict_factory fill --what examples --target ja --base vi --limit 40 --dry-run >> "$LOG" 2>&1 || true
"$PY" -u -m dict_factory fill --what units --target ja --limit 12 --dry-run >> "$LOG" 2>&1 || true
echo "=== extra warehouse $(date) ===" >> "$LOG"
"$PY" -u -m dict_factory extra >> "$LOG" 2>&1
echo "=== compile $(date) ===" >> "$LOG"
"$PY" -u -m dict_factory compile --sync-frontend >> "$LOG" 2>&1
echo "=== done $(date) ==="
