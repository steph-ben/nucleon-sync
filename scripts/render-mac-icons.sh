#!/bin/bash
# The macOS tray cannot read SVG before macOS 13, so it ships PNG copies of desktop/linux/icons/*.svg (72 px, drawn at 18 pt).
# Run this after changing an SVG: test/tray-parity.test.ts fails when a PNG is missing. Needs macOS (qlmanage).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT=desktop/macos/icons
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
for svg in desktop/linux/icons/*.svg; do
    qlmanage -t -s 72 -o "$TMP" "$svg" >/dev/null 2>&1
    mv "$TMP/$(basename "$svg").png" "$OUT/$(basename "$svg" .svg).png"
done
ls "$OUT"
