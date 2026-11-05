# Migration depuis rclone bisync

Procédure pour les deux machines (Mac et Linux). Ne passer à l'étape suivante que si la précédente est correcte.

Copie de sécurité : `~/proton-safety-2026-11-05` sur le Mac. Les 5 documents Proton natifs n'y sont pas.

1. Test isolé, sans toucher à `~/Proton`, dans un espace `device:proton-sync-test/sandbox` avec un dossier temporaire :

        mkdir -p /tmp/ps-test
        export PROTON_SYNC_HOME=/tmp/ps-home
        proton-sync login
        proton-sync init /tmp/ps-test device:proton-sync-test/sandbox
        proton-sync plan
        proton-sync once

   Créer, renommer et supprimer quelques fichiers dans `/tmp/ps-test`, relancer `once`, vérifier sur le web. Puis `unset PROTON_SYNC_HOME`.

2. Arrêter rclone sur les DEUX machines avant toute autre chose.

   Mac :

        launchctl bootout gui/$(id -u)/org.rclone.protondrive-bisync

   Linux :

        systemctl --user disable --now rclone-bisync.timer

3. Dernière vérification manuelle : les deux copies de `~/Proton` doivent être identiques entre elles et avec le Drive. Par exemple, sur chaque machine :

        find ~/Proton -type f -not -path '*/.sync-config/*' | sort | wc -l

   Comparer les nombres, puis contrôler à l'œil les écarts éventuels sur le web.

4. Initialiser sur le Mac :

        proton-sync init ~/Proton root

   Puis ajouter à la main `"allowDriveRoot": true` dans `~/.local/share/proton-sync/config.json`.

5. Contrôler le plan :

        proton-sync plan

   Résultat attendu : uniquement des actions `link` (463 le 2026-11-05, sur un clone de `~/Proton`). `coucou`, le fichier vide, est déjà sur le Drive et ne demande pas d'envoi. Aucun téléchargement, aucune mise à la corbeille.
   Si le plan contient autre chose : s'arrêter, ne pas lancer `once`, comprendre l'écart.

6. Première passe :

        proton-sync once

7. Démarrer le démon sur le Mac :

        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.protonsync.daemon.plist

   Puis refaire les étapes 4 à 6 sur Linux, et démarrer le démon :

        systemctl --user daemon-reload && systemctl --user enable --now proton-sync.service

8. Retour arrière : arrêter le démon, puis réactiver rclone.

   Mac :

        launchctl bootout gui/$(id -u)/org.protonsync.daemon
        launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.rclone.protondrive-bisync.plist

   Linux :

        systemctl --user disable --now proton-sync.service
        systemctl --user enable --now rclone-bisync.timer

   rclone bisync aura perdu son état de référence : il demandera un `--resync`. Cette opération est délicate,
   car elle refait l'appariement sans mémoire des suppressions et peut recréer ou dupliquer des fichiers.
   La faire sur une seule machine à la fois, après avoir vérifié l'état du Drive et de la copie de sécurité.
