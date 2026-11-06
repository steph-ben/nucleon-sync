#!/bin/sh
# nucleon-sync installer. Usage: curl -fsSL <this file> | sh
# Runs as a normal user, never as root. Writes only under ~/.local. The code is in main(), called on the last line,
# so a truncated download runs nothing.
#
# Test and update hooks (environment):
#   NUCLEON_BASE_URL   where nucleon-sync-<version>.tar.gz is downloaded from
#   NUCLEON_BUN_URL / NUCLEON_BUN_SHA256   another bun zip and its checksum
#   NUCLEON_SWITCH=0   unpack the version only; leave "current" and the command alone
#   NUCLEON_UNAME_S / NUCLEON_UNAME_M   pretend to be another platform

# Filled in by scripts/build-release.sh.
# VERSION names the archive. RELEASE (0.3.0-beta, or 0.3.0) names the tag and the folder in versions/.
VERSION="@VERSION@"
RELEASE="@RELEASE@"
ARCHIVE_SHA256="@ARCHIVE_SHA256@"

BUN_VERSION="1.4.2"
BUN_BASE_URL="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
# From SHASUMS256.txt of that bun release.
SHA_LINUX_X64="36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913"
SHA_LINUX_X64_BASELINE="c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f"
SHA_DARWIN_X64="80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012"
SHA_DARWIN_X64_BASELINE="bad5bbd6cf14d0980d115f5954c9ff904df619d5e994d2da1ffccd3f316300b0"

fail() {
    echo "nucleon-sync install: $*" >&2
    exit 1
}

check_tools() {
    for tool in curl unzip tar; do
        command -v "$tool" >/dev/null 2>&1 || fail "$tool is required but was not found."
    done
    command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail "sha256sum (or shasum on macOS) is required but was not found."
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    else
        shasum -a 256 "$1" | cut -d ' ' -f 1
    fi
}

# Exits with an error unless file $1 has checksum $2.
verify() {
    [ "$(sha256_of "$1")" = "$2" ] || fail "checksum mismatch for $(basename "$1"). Nothing was installed."
}

# Sets PLATFORM (linux or darwin) and BUN_FILE (zip name, "-baseline" without AVX2) and BUN_SHA256.
detect_platform() {
    os="${NUCLEON_UNAME_S:-$(uname -s)}"
    arch="${NUCLEON_UNAME_M:-$(uname -m)}"
    case "$os $arch" in
        "Linux x86_64")
            PLATFORM=linux
            grep -q avx2 /proc/cpuinfo 2>/dev/null && baseline=no || baseline=yes
            ;;
        "Darwin x86_64")
            PLATFORM=darwin
            [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null)" = 1 ] && baseline=no || baseline=yes
            ;;
        *) fail "$os $arch is not supported yet (Linux and macOS on Intel/AMD 64-bit only)." ;;
    esac
    if [ "$baseline" = yes ]; then
        BUN_FILE="bun-$PLATFORM-x64-baseline.zip"
    else
        BUN_FILE="bun-$PLATFORM-x64.zip"
    fi
    case "$BUN_FILE" in
        bun-linux-x64.zip) BUN_SHA256="$SHA_LINUX_X64" ;;
        bun-linux-x64-baseline.zip) BUN_SHA256="$SHA_LINUX_X64_BASELINE" ;;
        bun-darwin-x64.zip) BUN_SHA256="$SHA_DARWIN_X64" ;;
        bun-darwin-x64-baseline.zip) BUN_SHA256="$SHA_DARWIN_X64_BASELINE" ;;
    esac
}

# Downloads bun into $APP/bun unless this bun version is already there.
install_bun() {
    if [ -x "$APP/bun/bun" ] && [ "$("$APP/bun/bun" --version 2>/dev/null)" = "$BUN_VERSION" ]; then
        return
    fi
    echo "Downloading bun $BUN_VERSION..."
    curl -fsSL "${NUCLEON_BUN_URL:-$BUN_BASE_URL/$BUN_FILE}" -o "$TMP/bun.zip" || fail "could not download bun."
    verify "$TMP/bun.zip" "${NUCLEON_BUN_SHA256:-$BUN_SHA256}"
    unzip -oq "$TMP/bun.zip" -d "$TMP/bun-unzipped" </dev/null || fail "could not unzip bun."
    mkdir "$TMP/bun-new"
    cp "$TMP"/bun-unzipped/*/bun "$TMP/bun-new/bun" || fail "the bun zip has no bun program."
    chmod +x "$TMP/bun-new/bun" || fail "could not make bun executable."
    "$TMP/bun-new/bun" --version >/dev/null 2>&1 || fail "the downloaded bun does not start on this system. Nothing was installed."
    # Old bun aside, new bun in, old bun deleted. If the second move fails, the old bun comes back.
    if [ -d "$APP/bun" ]; then
        mv "$APP/bun" "$TMP/bun-old" || fail "could not replace bun."
    fi
    if ! mv "$TMP/bun-new" "$APP/bun"; then
        [ ! -d "$TMP/bun-old" ] || mv "$TMP/bun-old" "$APP/bun"
        fail "could not install bun."
    fi
}

# Downloads and checks the archive, unless this release is already there. Comes before anything is changed.
fetch_archive() {
    if [ -d "$APP/versions/$RELEASE" ]; then
        [ -x "$APP/versions/$RELEASE/bin/nucleon-sync" ] || fail "$APP/versions/$RELEASE is incomplete. Move it away and run the installer again."
        echo "nucleon-sync $RELEASE was already there: it was not downloaded or checked again."
        return
    fi
    echo "Downloading nucleon-sync $RELEASE..."
    curl -fsSL "${NUCLEON_BASE_URL:-https://github.com/steph-ben/nucleon-sync/releases/download/v$RELEASE}/nucleon-sync-$VERSION.tar.gz" -o "$TMP/app.tar.gz" || fail "could not download nucleon-sync $RELEASE."
    verify "$TMP/app.tar.gz" "$ARCHIVE_SHA256"
}

# Unpacks the archive fetched above into $APP/versions/$RELEASE.
install_version() {
    [ -f "$TMP/app.tar.gz" ] || return 0
    mkdir "$TMP/version"
    tar -xzf "$TMP/app.tar.gz" -C "$TMP/version" || fail "could not unpack the archive."
    mkdir -p "$APP/versions" || fail "could not create $APP/versions."
    # Without this check, mv would put the folder inside an existing one.
    [ ! -e "$APP/versions/$RELEASE" ] || fail "$APP/versions/$RELEASE appeared during the install. Run the installer again."
    mv "$TMP/version" "$APP/versions/$RELEASE" || fail "could not move nucleon-sync $RELEASE into place."
    [ -x "$APP/versions/$RELEASE/bin/nucleon-sync" ] || fail "nucleon-sync $RELEASE is incomplete after unpacking."
}

switch_to_version() {
    [ -x "$APP/versions/$RELEASE/bin/nucleon-sync" ] || fail "nucleon-sync $RELEASE is missing. Nothing was switched."
    ln -sfn "versions/$RELEASE" "$APP/current" || fail "could not switch to nucleon-sync $RELEASE."
    mkdir -p "$HOME/.local/bin" || fail "could not create ~/.local/bin."
    ln -sfn "$APP/current/bin/nucleon-sync" "$HOME/.local/bin/nucleon-sync" || fail "could not link the command."
}

print_next_steps() {
    echo "nucleon-sync $RELEASE is installed."
    case ":$PATH:" in
        *":$HOME/.local/bin:"*)
            echo "Next step: nucleon-sync setup"
            ;;
        *)
            echo "Add the command to your PATH (put this line in your shell profile):"
            echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
            echo "Next step: $HOME/.local/bin/nucleon-sync setup"
            ;;
    esac
}

main() {
    set -eu
    check_tools
    [ "$(id -u)" != 0 ] || fail "do not run this as root. It installs into your home folder."
    detect_platform

    DATA="$HOME/.local/share/nucleon-sync"
    APP="$DATA/app"
    mkdir -p "$DATA/.tmp" "$APP" || fail "could not create $DATA."
    TMP="$(mktemp -d "$DATA/.tmp/install.XXXXXX")" || fail "could not create a temporary folder."
    trap 'rm -rf "$TMP"; rmdir "$DATA/.tmp" 2>/dev/null || true' EXIT
    trap 'exit 1' HUP INT TERM

    fetch_archive
    install_bun
    install_version
    if [ "${NUCLEON_SWITCH:-1}" = 0 ]; then
        echo "nucleon-sync $RELEASE is unpacked, not switched on."
        return
    fi
    switch_to_version
    print_next_steps
}

main "$@"
