#!/bin/bash
# Applies Proton's patch (config/js/patches) to @protontech/crypto after npm install.
set -e
cd "$(dirname "$0")/.."
D=node_modules/@protontech/crypto/src/pmcrypto
for f in "$D/openpgp.ts" "$D/pmcrypto.d.ts"; do
    sed -i.bak 's#"openpgp/lightweight"#"openpgp"#g' "$f"
    rm -f "$f.bak"
done
