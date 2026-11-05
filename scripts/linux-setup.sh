#!/bin/bash
# One command for the Linux laptop: bun, dependencies, command link, service file, then all the tests.
# Starts nothing and touches neither the Drive nor ~/Proton. Safe to run again.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BUN_VERSION=1.4.2

say() { printf '\n== %s\n' "$1"; }
missing=()
command -v npm >/dev/null 2>&1 || missing+=(npm)
command -v curl >/dev/null 2>&1 || missing+=(curl)
command -v unzip >/dev/null 2>&1 || missing+=(unzip)
if [ ${#missing[@]} -gt 0 ]; then
    echo "Install first: ${missing[*]}" >&2
    exit 1
fi

say "bun $BUN_VERSION"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
    curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
fi
bun --version

say 'dependencies, command and service file'
bash scripts/install.sh

say 'session storage'
if ldconfig -p 2>/dev/null | grep -q libsecret; then
    echo 'libsecret found.'
else
    echo 'libsecret not found: sudo dnf install libsecret gnome-keyring, before proton-sync login.'
fi

say 'tests (temporary folders only, no account needed, a few minutes)'
bash scripts/test-all.sh

say 'next'
echo 'proton-sync setup   (or proton-sync login, then docs/linux-install.md from step 3)'
