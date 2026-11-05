#!/bin/bash
# Idempotent install. Does not load, enable or start any service.
set -e
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/bun" ] && [ ! -x "$HOME/.bun/bin/bun" ]; then
    echo "bun not found (PATH, ~/.local/bin/bun or ~/.bun/bin/bun). Install bun first." >&2
    exit 1
fi

npm install --ignore-scripts --no-audit --no-fund
bash scripts/patch-crypto.sh

mkdir -p "$HOME/.local/bin"
ln -sfn "$ROOT/bin/proton-sync" "$HOME/.local/bin/proton-sync"
echo "link: ~/.local/bin/proton-sync -> $ROOT/bin/proton-sync"

case "$(uname -s)" in
    Darwin)
        DEST="$HOME/Library/LaunchAgents/org.protonsync.daemon.plist"
        mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
        sed "s#__HOME__#$HOME#g" deploy/org.protonsync.daemon.plist > "$DEST"
        echo "launchd agent copied: $DEST"
        echo "To start it: launchctl bootstrap gui/$(id -u) $DEST"
        ;;
    Linux)
        DEST="$HOME/.config/systemd/user/proton-sync.service"
        mkdir -p "$HOME/.config/systemd/user"
        # The unit runs from ~/dev/proton-sync by default: point it at this checkout.
        sed "s#%h/dev/proton-sync#$ROOT#g" deploy/proton-sync.service > "$DEST"
        echo "systemd unit copied: $DEST"
        echo "To start it: systemctl --user daemon-reload && systemctl --user enable --now proton-sync.service"
        ;;
    *)
        echo "unsupported system for the service: $(uname -s)" >&2
        ;;
esac
