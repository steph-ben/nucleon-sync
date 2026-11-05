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
ln -sfn "$ROOT/bin/nucleon-sync" "$HOME/.local/bin/nucleon-sync"
echo "link: ~/.local/bin/nucleon-sync -> $ROOT/bin/nucleon-sync"

case "$(uname -s)" in
    Darwin)
        DEST="$HOME/Library/LaunchAgents/org.nucleonsync.daemon.plist"
        mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
        sed "s#__HOME__#$HOME#g" deploy/org.nucleonsync.daemon.plist > "$DEST"
        echo "launchd agent copied: $DEST"
        DATA="${NUCLEON_SYNC_HOME:-$HOME/.local/share/nucleon-sync}"
        if command -v swiftc >/dev/null 2>&1; then
            swiftc -O desktop/macos/NucleonSyncTray.swift -o "$HOME/.local/bin/nucleon-sync-tray" 2>/dev/null
            TRAY="$HOME/Library/LaunchAgents/org.nucleonsync.tray.plist"
            sed -e "s#__HOME__#$HOME#g" -e "s#__DATA__#$DATA#g" deploy/org.nucleonsync.tray.plist > "$TRAY"
            echo "menu bar icon built, starts at the next login. Now: launchctl bootstrap gui/$(id -u) $TRAY"
        else
            echo "swiftc not found: no menu bar icon (xcode-select --install)"
        fi
        echo "To start it: launchctl bootstrap gui/$(id -u) $DEST"
        ;;
    Linux)
        DEST="$HOME/.config/systemd/user/nucleon-sync.service"
        mkdir -p "$HOME/.config/systemd/user"
        # The unit runs ~/.local/bin/nucleon-sync, the link made above.
        cp deploy/nucleon-sync.service "$DEST"
        echo "systemd unit copied: $DEST"
        echo "To start it: systemctl --user daemon-reload && systemctl --user enable --now nucleon-sync.service"
        DATA="${NUCLEON_SYNC_HOME:-$HOME/.local/share/nucleon-sync}"
        mkdir -p "$HOME/.config/autostart"
        sed -e "s#__HOME__#$HOME#g" -e "s#__ROOT__#$ROOT#g" -e "s#__DATA__#$DATA#g" deploy/nucleon-sync-tray.desktop > "$HOME/.config/autostart/nucleon-sync-tray.desktop"
        echo "tray icon starts at the next login. Fedora GNOME needs, once:"
        echo "  sudo dnf install gnome-shell-extension-appindicator libayatana-appindicator-gtk3 python3-gobject libnotify"
        echo "  gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com   (after logging out and in)"
        ;;
    *)
        echo "unsupported system for the service: $(uname -s)" >&2
        ;;
esac
