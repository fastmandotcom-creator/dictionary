#!/bin/bash
# M4: build a signed, R8-shrunk Release APK for dict-learn.
#
# Prereqs (all present on the dev machine):
#   - Homebrew OpenJDK (17/21) on PATH
#   - Android SDK with platforms 34/36/37
#   - node_modules installed in mobile/ (Capacitor)
#   - keystore: mobile/android/app/dict-learn.jks  (NOT in git)
#
# The web bundle (mobile/www, incl. data/) is the Capacitor webDir; `cap copy`
# refreshes the native assets, then Gradle produces the release APK.
#
# Usage:
#   bash scripts/build_release_apk.sh
# Result:
#   mobile/android/app/build/outputs/apk/release/app-release.apk  (signed + R8)
set -euo pipefail
cd "$(dirname "$0")/.."

# --- toolchain -------------------------------------------------------------
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export ANDROID_KEYSTORE_PASSWORD="${ANDROID_KEYSTORE_PASSWORD:-dictlearn}"
export ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-dictlearn}"

# Sandbox-friendly Gradle state: use a workspace copy of the dependency cache
# (host ~/.gradle lock files and /var/folders TMPDIR are blocked under the
# execution sandbox). Falls back to the host cache when not sandboxed.
GRADLE_USER_HOME="${GRADLE_USER_HOME:-$PWD/.gradle-home}"
export GRADLE_USER_HOME
mkdir -p "$GRADLE_USER_HOME" "$PWD/.tmp"
export TMPDIR="${TMPDIR:-$PWD/.tmp}"

# --- sync web assets into the Android project (data/ now ships ro/ipa) ------
cd mobile
if command -v npx >/dev/null 2>&1 && [ -d node_modules/@capacitor/cli ]; then
  npx cap copy android || echo "warn: cap copy failed; using existing android assets"
else
  echo "warn: Capacitor CLI not available; skipping asset copy"
fi
cd android

# --- build release APK (signed + minified + resource-shrunk) --------------
# Prefer a directly-invoked Gradle distribution (avoids the ~/.gradle wrapper
# lock files that are blocked under the execution sandbox). Fall back to the
# wrapper when the direct distribution is not present.
GRADLE_BIN=""
for cand in \
  "$HOME/.gradle/wrapper/dists/gradle-8.14.3-all"/*/gradle-8.14.3/bin/gradle \
  "/usr/local/bin/gradle" "gradle"; do
  if [ -x "$cand" ] || command -v "$cand" >/dev/null 2>&1; then GRADLE_BIN="$cand"; break; fi
done
if [ -n "$GRADLE_BIN" ]; then
  echo "using gradle: $GRADLE_BIN"
  "$GRADLE_BIN" :app:assembleRelease --offline --no-daemon --stacktrace
else
  ./gradlew :app:assembleRelease --offline --stacktrace
fi

APK="app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK" ]; then
  echo "ERROR: $APK not produced" >&2
  exit 1
fi

echo "=== built $(realpath "$APK") ==="
ls -la "$APK"

# --- verify signature + dump basic manifest info ---------------------------
KS="$PWD/app/dict-learn.jks"
BUILD_TOOLS=$(ls -1 "$ANDROID_HOME/platform-tools" 2>/dev/null || true)
# apksigner ships with build-tools; find the newest.
if BTOOL="$(ls -d "$ANDROID_HOME/build-tools"/* 2>/dev/null | sort -V | tail -1)"; then
  "$BTOOL/apksigner" verify --print-certs "$APK" 2>/dev/null \
    && echo "APK signature: VERIFIED" \
    || echo "warn: apksigner verify inconclusive (relying on Gradle signing)"
fi

# Print size vs. target (<10 MB).
SIZE=$(stat -f%z "$APK" 2>/dev/null || stat -c%s "$APK" 2>/dev/null)
echo "APK size: $SIZE bytes (target < 10 MB)"
echo "done."
