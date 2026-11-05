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
        DATA="${PROTON_SYNC_HOME:-$HOME/.local/share/proton-sync}"
        if command -v swiftc >/dev/null 2>&1; then
            swiftc -O desktop/macos/ProtonSyncTray.swift -o "$HOME/.local/bin/proton-sync-tray" 2>/dev/null
            TRAY="$HOME/Library/LaunchAgents/org.protonsync.tray.plist"
            sed -e "s#__HOME__#$HOME#g" -e "s#__DATA__#$DATA#g" deploy/org.protonsync.tray.plist > "$TRAY"
            echo "menu bar icon built, starts at the next login. Now: launchctl bootstrap gui/$(id -u) $TRAY"
        else
            echo "swiftc not found: no menu bar icon (xcode-select --install)"
        fi
        echo "To start it: launchctl bootstrap gui/$(id -u) $DEST"
        ;;
    Linux)
        DEST="$HOME/.config/systemd/user/proton-sync.service"
        mkdir -p "$HOME/.config/systemd/user"
        # The unit runs from ~/dev/proton-sync by default: point it at this checkout.
        sed "s#%h/dev/proton-sync#$ROOT#g" deploy/proton-sync.service > "$DEST"
        echo "systemd unit copied: $DEST"
        echo "To start it: systemctl --user daemon-reload && systemctl --user enable --now proton-sync.service"
        DATA="${PROTON_SYNC_HOME:-$HOME/.local/share/proton-sync}"
        mkdir -p "$HOME/.config/autostart"
        sed -e "s#__HOME__#$HOME#g" -e "s#__ROOT__#$ROOT#g" -e "s#__DATA__#$DATA#g" deploy/proton-sync-tray.desktop > "$HOME/.config/autostart/proton-sync-tray.desktop"
        echo "tray icon starts at the next login. Fedora GNOME needs, once:"
        echo "  sudo dnf install gnome-shell-extension-appindicator libayatana-appindicator-gtk3 python3-gobject libnotify"
        echo "  gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com   (after logging out and in)"
        ;;
    *)
        echo "unsupported system for the service: $(uname -s)" >&2
        ;;
esac
