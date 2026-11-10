#!/bin/bash
# Sync regenerated mobile data (out/mobile/www) into the Capacitor webDir
# (mobile/www/data). Capacitor webDir = "www" and app.js fetches data/*.json
# + data/lang/*.json, so the bundled APK must carry the data under mobile/www/data.
#
# Usage:
#   python3 -m dict_factory export-mobile   # regenerate out/mobile/www
#   bash scripts/sync_mobile_data.sh         # mirror into mobile/www/data
#   (inside mobile/) npx cap copy            # rebuild the Android bundle
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="out/mobile/www"
DST="mobile/www/data"
if [ ! -d "$SRC" ]; then
  echo "error: $SRC missing; run 'python3 -m dict_factory export-mobile' first" >&2
  exit 1
fi
# Remove stale generated files only (never touch source: app.js, index.html, sql-wasm.*).
rm -f "$DST"/concepts.json "$DST"/langs.json "$DST"/drills.json "$DST"/lang/*.json
mkdir -p "$DST/lang"
for name in concepts.json langs.json drills.json; do
  [ -f "$SRC/$name" ] && cp -f "$SRC/$name" "$DST/$name"
done
cp -f "$SRC"/lang/*.json "$DST/lang/"
echo "synced mobile data ($(ls "$DST"/lang | wc -l | tr -d ' ') language files):"
du -sh "$DST"
