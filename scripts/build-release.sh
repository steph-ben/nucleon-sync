#!/bin/bash
# Builds dist/nucleon-sync-<version>.tar.gz, dist/SHA256SUMS and dist/install.sh. Usage: scripts/build-release.sh <version> [tag]
# The archive holds one bundled program file, not node_modules. Set SKIP_BUNDLE_TESTS=1 to skip the tests run against the bundle.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
VERSION="${1:?usage: scripts/build-release.sh <version> [tag]}"
ARCHIVE="nucleon-sync-$VERSION.tar.gz"

# The version in src/names.ts is what the program reports, so the release must carry the same one.
SOURCE_VERSION="$(sed -n "s/^export const VERSION = '\(.*\)';/\1/p" src/names.ts)"
[ "$VERSION" = "$SOURCE_VERSION" ] || { echo "version $VERSION differs from VERSION $SOURCE_VERSION in src/names.ts" >&2; exit 1; }
# The tag is v<release>, for example v0.2.0-beta: update.ts and install.sh build their addresses from it.
RELEASE="$(bun --eval "import('./src/names.ts').then((names) => console.log(names.RELEASE_VERSION))")"
TAG="${2:-v$RELEASE}"
[ "$TAG" = "v$RELEASE" ] || { echo "tag $TAG differs from v$RELEASE, the release in src/names.ts" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
rm -rf dist
mkdir -p dist
bun build src/main.ts --target bun --outfile dist/nucleon-sync.js --metafile="$STAGE/meta.json"

# Same tests as usual, but the program they start is the bundle.
if [ -z "${SKIP_BUNDLE_TESTS:-}" ]; then
    NUCLEON_ENTRY="$PWD/dist/nucleon-sync.js" bun test test/integration.test.ts test/desktop.test.ts test/catalog/machine.test.ts
fi

mkdir "$STAGE/bin"
cp dist/nucleon-sync.js "$STAGE/"
cp bin/nucleon-sync "$STAGE/bin/"
cp -r deploy "$STAGE/deploy"
mkdir -p "$STAGE/desktop/linux"
cp desktop/linux/nucleon-sync-tray.py "$STAGE/desktop/linux/"
cp -r desktop/linux/icons "$STAGE/desktop/linux/icons"
mkdir -p "$STAGE/desktop/macos"
cp desktop/macos/NucleonSyncTray.swift "$STAGE/desktop/macos/"
cp -r desktop/macos/icons "$STAGE/desktop/macos/icons"
cp LICENSE "$STAGE/"
bun scripts/third-party-notices.ts "$STAGE/meta.json" > "$STAGE/THIRD-PARTY-NOTICES"
echo "$RELEASE" > "$STAGE/VERSION"

tar -czf "dist/$ARCHIVE" -C "$STAGE" nucleon-sync.js bin deploy desktop LICENSE THIRD-PARTY-NOTICES VERSION
# sha256sum is not on macOS: shasum prints the same "<hash>  <file>" line.
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
(cd dist && sha256 "$ARCHIVE" > SHA256SUMS)
# The installer carries the release and the archive checksum, so it installs exactly this release.
ARCHIVE_SHA256="$(cut -d ' ' -f 1 "dist/SHA256SUMS")"
sed -e "s/@VERSION@/$VERSION/" -e "s/@RELEASE@/$RELEASE/" -e "s/@ARCHIVE_SHA256@/$ARCHIVE_SHA256/" install/install.sh > dist/install.sh
echo "built dist/$ARCHIVE ($(du -h "dist/$ARCHIVE" | cut -f1))"
