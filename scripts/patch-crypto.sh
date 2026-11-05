#!/bin/bash
# Applique le patch de Proton (config/js/patches) à @protontech/crypto après npm install.
set -e
cd "$(dirname "$0")/.."
D=node_modules/@protontech/crypto/src/pmcrypto
for f in "$D/openpgp.ts" "$D/pmcrypto.d.ts"; do
    sed -i.bak 's#"openpgp/lightweight"#"openpgp"#g' "$f"
    rm -f "$f.bak"
done
