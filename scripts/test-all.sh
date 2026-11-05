#!/bin/bash
# Runs everything that needs no Proton account, and prints one verdict. Safe: temporary folders only.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT="$(mktemp -d)"
fail=0
step() {
    local name="$1"; shift
    if "$@" > "$OUT/log" 2>&1; then
        echo "ok    $name"
    else
        echo "FAIL  $name"
        grep -E '^\(fail\)|^error|^seed' "$OUT/log" | head -20
        fail=1
    fi
}
step 'main tests' bun test test/local.test.ts test/scenarios.test.ts test/integration.test.ts test/proton-adapter.test.ts test/journal.test.ts test/watch-real.test.ts test/desktop.test.ts test/names.test.ts
step 'catalogue' env CATALOG_OUT="$OUT/catalog.jsonl" bun test test/catalog
step 'catalogue report' bun scripts/catalog-report.ts "$OUT/catalog.jsonl" "$OUT/test-catalog.md"
step 'fuzz' bun test test/fuzz.test.ts test/fuzz-real.test.ts
[ -f "$OUT/test-catalog.md" ] && sed -n 5p "$OUT/test-catalog.md"
if [ "$fail" = 0 ]; then echo 'ALL GREEN'; else echo "SOMETHING FAILED, full log of the last step: $OUT/log"; exit 1; fi
