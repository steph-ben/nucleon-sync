#!/bin/bash
# Replays everyday gestures against the real Drive, between the two sandbox folders of this Mac.
# Refuses anything but device:proton-sync-test/sandbox. Small files by default.
# Usage: scripts/real-check.sh [--large]   (--large also transfers 1 GB: real bandwidth)
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$HOME/dev/proton-sync-sandbox"
A="$SANDBOX/a"
B="$SANDBOX/b"
HOME_A="$HOME/.local/share/proton-sync"
HOME_B="$SANDBOX/home-b"
TARGET='device:proton-sync-test/sandbox'
RUN="check-$(date +%H%M%S)"
LARGE="${1:-}"

for h in "$HOME_A" "$HOME_B"; do
    remote="$(sed -n 's/.*"remote": *"\([^"]*\)".*/\1/p' "$h/config.json")"
    if [ "$remote" != "$TARGET" ]; then
        echo "refused: $h targets '$remote', not $TARGET" >&2
        exit 1
    fi
done

a() { PROTON_SYNC_HOME="$HOME_A" "$ROOT/bin/proton-sync" once >/dev/null; }
b() { PROTON_SYNC_HOME="$HOME_B" "$ROOT/bin/proton-sync" once >/dev/null; }
same() { diff -r -x '.proton-sync*' -x '.DS_Store' "$A" "$B" >/dev/null; }

# Drive events can lag behind: wait for both sides to agree.
settle() {
    for _ in 1 2 3 4 5 6 7 8; do
        a; b
        if same; then a; b; same && return 0; fi
        sleep 3
    done
    diff -r -x '.proton-sync*' -x '.DS_Store' "$A" "$B" || true
    return 1
}

passed=0
check() {
    local name="$1"; shift
    settle
    if "$@"; then
        echo "ok    $name"
        passed=$((passed + 1))
    else
        echo "FAIL  $name" >&2
        exit 1
    fi
}

D="$A/$RUN"
E="$B/$RUN"
mkdir -p "$D/Albums/2024"
printf 'photo' > "$D/Albums/2024/plage.jpg"
printf 'accent' > "$D/Albums/Été à la plage 📷.txt"
: > "$D/vide.txt"
printf 'note' > "$D/note.md"
check 'add: files, accents, emoji, empty file' test -f "$E/Albums/2024/plage.jpg"

printf 'note v2' > "$D/note.md"
check 'edit' grep -q 'note v2' "$E/note.md"

inode="$(stat -f %i "$E/Albums/2024/plage.jpg")"
mv "$D/Albums" "$D/Vacances"
same_inode() { [ "$(stat -f %i "$E/Vacances/2024/plage.jpg" 2>/dev/null)" = "$inode" ]; }
check 'folder rename reaches the other side without a transfer' same_inode

mkdir "$E/Archives"
mv "$E/note.md" "$E/Archives/note.md"
check 'move from the other side' test -f "$D/Archives/note.md"

printf 'version A' > "$D/Archives/note.md"
printf 'version B' > "$E/Archives/note.md"
a; b
check 'conflict keeps both versions' sh -c "grep -rqs 'version A' '$E/Archives' && grep -rqs 'version B' '$E/Archives'"

printf 'titre=ancien' > "$D/titre.mp3"
settle
stamp="$(stat -f %m "$D/titre.mp3")"
printf 'titre=nouvel' > "$D/titre.mp3"
touch -t "$(date -r "$stamp" +%Y%m%d%H%M.%S)" "$D/titre.mp3"
check 'same-size edit with date preserved' grep -q 'titre=nouvel' "$E/titre.mp3"

rm "$D/vide.txt"
check 'delete' test ! -e "$E/vide.txt"

if [ "$LARGE" = '--large' ]; then
    dd if=/dev/urandom of="$D/gros.bin" bs=1m count=1024 2>/dev/null
    check '1 GB file' cmp -s "$D/gros.bin" "$E/gros.bin"
fi

rm -rf "$D"
check 'whole folder deleted' test ! -e "$E"
echo "$passed checks passed against the real Drive"
