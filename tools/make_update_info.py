#!/usr/bin/env python3
"""Emit update-info.json for a dict-learn GitHub Release (schema 1).

Ported from duosub-study's tools/automatic_release.py (update_info +
minimum_safe_version_code): the latest release carries a small
update-info.json that the app reads from GitHub's download hosts
(no rate limit, no API) instead of api.github.com. The release
workflow/publisher uploads it next to the .apk and .sha256.

Usage:
  python3 tools/make_update_info.py dist/dict-learn-v1.5.0-android.apk \\
      --version 1.5.0 --version-code 7 --apk-name dict-learn-v1.5.0-android.apk \\
      --minimum-safe 0 [--security-min 7]
  -> dist/update-info.json

Semantics (duosub-study's update-info schema):
  schema=1, version is strict X.Y.Z, version_code must be > 0,
  sha256 is lowercase hex of the APK bytes, size is the byte length,
  minimum_safe_version_code = the highest version code of a published
  security-critical release (0 when none). The app shows a security
  reminder when its installed version_code < minimum_safe_version_code.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

STABLE = re.compile(r"^\d{1,4}\.\d{1,4}\.\d{1,4}$")
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
APK_NAME = "dict-learn-android.apk"  # canonical apk asset name the app expects


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("apk", type=Path, help="path to the signed APK")
    ap.add_argument("--version", required=True, help="strict X.Y.Z version")
    ap.add_argument("--version-code", type=int, required=True, help="APK versionCode (>0)")
    ap.add_argument("--apk-name", default=APK_NAME, help="APK asset name in the release")
    ap.add_argument("--minimum-safe", type=int, default=0,
                    help="minimum_safe_version_code (highest published security-fix code, or this release's code when --security-min is set)")
    ap.add_argument("--security-min", action="store_true",
                    help="mark this release as a security fix: minimum_safe_version_code = this version code")
    ap.add_argument("--out", type=Path, default=None, help="output file (default: alongside the apk)")
    args = ap.parse_args()

    if not STABLE.fullmatch(args.version):
        ap.error(f"--version must be stable X.Y.Z, got {args.version}")
    if args.version_code <= 0:
        ap.error("--version-code must be > 0")
    if not args.apk.is_file():
        ap.error(f"APK not found: {args.apk}")

    data = args.apk.read_bytes()
    if args.security_min:
        # This release is a security fix: everyone below it must update, so
        # the safe floor is at least this release's own version code.
        minimum_safe = max(args.minimum_safe, args.version_code)
    else:
        minimum_safe = args.minimum_safe
    # duosub invariant: the safe floor never exceeds the newest release's code.
    minimum_safe = max(0, min(minimum_safe, args.version_code))

    info = {
        "schema": 1,
        "version": args.version,
        "version_code": args.version_code,
        "minimum_safe_version_code": minimum_safe,
        "apk": args.apk_name,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
    }
    out = args.out or args.apk.parent / "update-info.json"
    out.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out} (schema 1, version {info['version']}, code {info['version_code']}, "
          f"minimum_safe {info['minimum_safe_version_code']}, sha256 {info['sha256'][:16]}…, "
          f"{info['size']} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
