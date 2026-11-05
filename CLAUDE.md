# proton-sync

Démon de synchro bidirectionnelle `~/Proton` ↔ Proton Drive (Mac macOS 12 Intel + laptop Linux), pour remplacer `rclone bisync`. Priorités : renommer un dossier sans galère et ne jamais rien perdre.

Conception : `docs/design.md`. Bascule : `docs/migration.md`.

## Règles absolues

- Aucun fichier du Drive ou de `~/Proton` ne doit être perdu. Les tests vont uniquement dans `device:proton-sync-test/sandbox`.
- Ne pas viser « Mes fichiers » (`root`, `allowDriveRoot`) ni couper rclone sans accord explicite de l'utilisateur.
- Aucune suppression définitive : `DriveApi` (`src/adapters/proton.ts`) n'expose ni `deleteNodes` ni `emptyTrash`.
- Identification honnête `external-drive-protonsync@…` : ne jamais se faire passer pour une appli Proton.
- Ne jamais demander de mot de passe dans le chat.
- Connexion mobile : ne pas retélécharger le SDK, garder les fichiers de test petits.
- Utiliser les skills Superpowers, git pour tout tracer, Sonnet pour les tâches mécaniques.

## Commandes

    export PATH=$HOME/.local/bin:$PATH
    bun test test/local.test.ts test/scenarios.test.ts test/integration.test.ts test/proton-adapter.test.ts
    bun test test/fuzz.test.ts
    npx tsc --noEmit 2>&1 | grep -E '^(src|test)/'    # les erreurs de node_modules/@protontech/crypto sont connues
    bin/proton-sync plan|once|run|approve|status

## Environnement de test réel

- Machine A : `~/.local/share/proton-sync` (config par défaut), dossier `~/dev/proton-sync-sandbox/a`.
- Machine B : `PROTON_SYNC_HOME=~/dev/proton-sync-sandbox/home-b`, dossier `~/dev/proton-sync-sandbox/b`.
- Session Proton déjà ouverte, dans le trousseau (`proton-sync/session`).
- Copie de sécurité : `~/proton-safety-2026-11-05` (lecture seule).

## Reste à faire

Liste à jour dans la mémoire du projet (`proton-sync-replacement`).
