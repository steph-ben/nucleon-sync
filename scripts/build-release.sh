#!/bin/bash
# Builds dist/nucleon-sync-<version>.tar.gz and dist/SHA256SUMS. Usage: scripts/build-release.sh <version>
# The archive holds one bundled program file, not node_modules. Set SKIP_BUNDLE_TESTS=1 to skip the tests run against the bundle.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
VERSION="${1:?usage: scripts/build-release.sh <version>}"
ARCHIVE="nucleon-sync-$VERSION.tar.gz"

rm -rf dist
mkdir -p dist
bun build src/main.ts --target bun --outfile dist/nucleon-sync.js

# Same tests as usual, but the program they start is the bundle.
if [ -z "${SKIP_BUNDLE_TESTS:-}" ]; then
    NUCLEON_ENTRY="$PWD/dist/nucleon-sync.js" bun test test/integration.test.ts test/desktop.test.ts test/catalog/machine.test.ts
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/bin"
cp dist/nucleon-sync.js "$STAGE/"
cp bin/nucleon-sync "$STAGE/bin/"
cp -r deploy "$STAGE/deploy"
cp LICENSE "$STAGE/"
echo "$VERSION" > "$STAGE/VERSION"

tar -czf "dist/$ARCHIVE" -C "$STAGE" nucleon-sync.js bin deploy LICENSE VERSION
(cd dist && sha256sum "$ARCHIVE" > SHA256SUMS)
echo "built dist/$ARCHIVE ($(du -h "dist/$ARCHIVE" | cut -f1))"
