#!/bin/bash
# The macOS tray cannot read SVG before macOS 13, so the logo shown in its menu ships as a PNG copy of desktop/linux/icons/nucleon-sync.svg
# (72 px, drawn at 18 pt). qlmanage draws it on white: the white is turned into transparency. The menu bar icons are drawn by the tray itself.
# Run this after changing the logo. Needs macOS (qlmanage, swiftc).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT=desktop/macos/icons
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
swiftc -O scripts/white-to-transparent.swift -o "$TMP/white-to-transparent"
qlmanage -t -s 72 -o "$TMP" desktop/linux/icons/nucleon-sync.svg >/dev/null 2>&1
"$TMP/white-to-transparent" "$TMP/nucleon-sync.svg.png" "$OUT/nucleon-sync.png"
ls "$OUT"
