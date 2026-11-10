#!/bin/bash
# Package the built release APK for public distribution (GitHub Release).
# Produces, under dist/:
#   dict-learn-v<ver>.apk            (the signed, R8-shrunk build)
#   dict-learn-v<ver>.apk.sha256     (integrity check for users)
#   RELEASE_NOTES.md                 (user-facing install instructions)
#
# Usage:  bash scripts/package_release_apk.sh
# Re-run it every time a new APK is built (e.g. after the M1 data chain
# finishes) so the packaged name + checksum always match the shipped binary.
set -euo pipefail
cd "$(dirname "$0")/.."

APK="mobile/android/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK" ]; then
  echo "ERROR: $APK not found — build it first (bash scripts/build_release_apk.sh)" >&2
  exit 1
fi
VERSION=$(grep -o 'versionName "[0-9.]*"' mobile/android/app/build.gradle | head -1 | sed 's/versionName "//;s/"//')
DIST="dist"
mkdir -p "$DIST"

OUT="$DIST/dict-learn-v${VERSION}-android.apk"
cp -f "$APK" "$OUT"

# SHA-256 for end users to verify they got an untampered binary.
if command -v shasum >/dev/null 2>&1; then
  SHASUM="$(shasum -a 256 "$OUT" | awk '{print $1}')"
else
  SHASUM="$(shasum -a 256 "$OUT" | awk '{print $1}')"
fi
echo "${SHASUM}  $(basename "$OUT")" > "$OUT.sha256"

# Data snapshot embedded in this build (for release notes transparency).
DATA_INFO="$(/opt/homebrew/bin/python3.11 - <<'EOF' 2>/dev/null || echo "unknown"
import sqlite3
c = sqlite3.connect('file:out/warehouse.db?mode=ro', uri=True)
d = c.execute("SELECT COUNT(DISTINCT concept_id) FROM sentence_drills WHERE topic='business'").fetchone()[0]
p = c.execute("SELECT COUNT(DISTINCT concept_id) FROM phonetics_text").fetchone()[0]
t = c.execute("SELECT COUNT(*) FROM concepts").fetchone()[0]
print(f"{t} words · {d} drill words · {p} phonetics readings")
EOF
)"

cat > "$DIST/RELEASE_NOTES.md" <<EOF
# dict-learn v${VERSION} — Android APK

Self-contained offline English→Vietnamese learning app (no server, no account).

## What's inside this build
- Word dataset: ${DATA_INFO}
- Drill / Fill-blank / Conjugate (active production), IPA + romanization on cards
- On-device microphone pronunciation check (Web Speech) — RECORD_AUDIO permission
- Offline PWA (service worker) + IndexedDB spaced-repetition store
- Signed (keystore 'dict-learn', CN=Dict Learn) + R8-minified

## Install
1. Download \`dict-learn-v${VERSION}-android.apk\` (and its \`.sha256\`).
2. Verify: \`shasum -a 256 -c dict-learn-v${VERSION}-android.apk.sha256\`
3. Tap the APK on your phone (Android 7.0+) and allow "Install from
   unknown sources" for your browser/file manager.
4. Grant **Microphone** permission only if you use the pronunciation check.

## Notes
- Works fully offline after first launch; progress persists in IndexedDB.
- Android 14+ may block installing unknown-source APKs via "Play Protect";
  allow the install when prompted (the APK is signed with our keystore).
EOF

echo "=== packaged: $OUT ==="
ls -la "$OUT" "$OUT.sha256" "$DIST/RELEASE_NOTES.md"
echo "SHA-256: ${SHASUM}"
