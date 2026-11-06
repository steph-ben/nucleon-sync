# nucleon-sync

Démon de synchro bidirectionnelle d'un dossier local (par défaut `~/Proton`) ↔ Proton Drive (Linux x64 et macOS Intel), pour remplacer `rclone bisync`. Anciennement `proton-sync`. Priorités : renommer un dossier sans galère et ne jamais rien perdre.

Conception : `docs/design.md`. Migration : `docs/migrating-from-proton-sync.md`.

## Règles absolues

- Aucun fichier du Drive ou de `~/Proton` ne doit être perdu. Les tests vont uniquement dans `device:nucleon-sync-test/sandbox`.
- Ne pas viser « Mes fichiers » (`root`, `allowDriveRoot`, ou le choix 1 de `setup`) ni couper rclone sans accord explicite de l'utilisateur.
- Aucune suppression définitive : `DriveApi` (`src/adapters/proton.ts`) n'expose ni `deleteNodes` ni `emptyTrash`.
- Identification honnête `external-drive-nucleon_sync@…` : ne jamais se faire passer pour une appli Proton.
- Ne jamais demander de mot de passe dans le chat.
- Connexion mobile : ne pas retélécharger le SDK, garder les fichiers de test petits.
- Utiliser les skills Superpowers, git pour tout tracer, Sonnet pour les tâches mécaniques.
- Tray Linux (`desktop/linux/nucleon-sync-tray.py`) et macOS (`desktop/macos/NucleonSyncTray.swift`) : même menu, mêmes mots, mêmes icônes. Toute modif va dans les deux fichiers ; `test/tray-parity.test.ts` le vérifie. Les icônes d'état de la barre macOS sont dessinées dans le Swift (image « template », monochrome, transparente comme les icônes du système) ; après avoir changé le logo SVG : `scripts/render-mac-icons.sh` (macOS < 13 ne lit pas le SVG).

## Commandes

    export PATH=$HOME/.local/bin:$PATH
    scripts/test-all.sh                  # everything without a Proton account
    bun scripts/mutants.ts               # safety mutants, long
    scripts/real-check.sh                # real Drive, sandbox only, macOS
    npx tsc --noEmit 2>&1 | grep -E '^(src|test)/'    # les erreurs de node_modules/@protontech/crypto sont connues
    bin/nucleon-sync plan|once|run|approve|status

## Environnement de test réel

- Machine A : `~/.local/share/nucleon-sync` (config par défaut), dossier `~/dev/nucleon-sync-sandbox/a`.
- Machine B : `NUCLEON_SYNC_HOME=~/dev/nucleon-sync-sandbox/home-b`, dossier `~/dev/nucleon-sync-sandbox/b`.
- Session Proton déjà ouverte, dans le trousseau (`nucleon-sync/session`).
- Copie de sécurité : `~/proton-safety-2026-11-05` (lecture seule).

## Reste à faire

Liste à jour dans la mémoire du projet (`proton-sync-replacement`).
