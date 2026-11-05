#!/bin/bash
# usage: dbg.sh seed crash [mid]  : dernière passe d'une graine
~/.local/bin/bun run test/debug-seed.ts "$@" 2>&1 | grep -E '^(--- |LOCAL|HUB|error)' | tail -${LINES_OUT:-8} | cut -c1-1300
