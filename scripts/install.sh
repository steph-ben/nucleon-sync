#!/bin/bash
# Installation idempotente. Ne charge, n'active et ne démarre aucun service.
set -e
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/bun" ]; then
    echo "bun introuvable (PATH ou ~/.local/bin/bun). Installer bun d'abord." >&2
    exit 1
fi

npm install --ignore-scripts --no-audit --no-fund
bash scripts/patch-crypto.sh

mkdir -p "$HOME/.local/bin"
ln -sfn "$ROOT/bin/proton-sync" "$HOME/.local/bin/proton-sync"
echo "lien : ~/.local/bin/proton-sync -> $ROOT/bin/proton-sync"

case "$(uname -s)" in
    Darwin)
        DEST="$HOME/Library/LaunchAgents/org.protonsync.daemon.plist"
        mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
        sed "s#__HOME__#$HOME#g" deploy/org.protonsync.daemon.plist > "$DEST"
        echo "agent launchd copié : $DEST"
        echo "Pour le démarrer : launchctl bootstrap gui/$(id -u) $DEST"
        ;;
    Linux)
        DEST="$HOME/.config/systemd/user/proton-sync.service"
        mkdir -p "$HOME/.config/systemd/user"
        cp deploy/proton-sync.service "$DEST"
        echo "unité systemd copiée : $DEST"
        echo "Pour le démarrer : systemctl --user daemon-reload && systemctl --user enable --now proton-sync.service"
        ;;
    *)
        echo "système non pris en charge pour le service : $(uname -s)" >&2
        ;;
esac
