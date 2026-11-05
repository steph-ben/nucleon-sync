# proton-sync

**Statut : testé sur le vrai service dans un espace isolé, entre deux dossiers d'un même Mac. Pas encore testé sur Linux ni sur « Mes fichiers ».**

Démon de synchronisation bidirectionnelle entre `~/Proton` et Proton Drive, pour macOS 12 Intel et Linux.
Il remplace `rclone bisync`. Conception détaillée : `docs/design.md`.

Client personnel et non officiel, basé sur le SDK Proton Drive. Sans lien avec Proton.
Il s'identifie auprès de Proton comme `external-drive-protonsync`.

Limites de Proton pour les espaces device, d'où le sous-dossier obligatoire en test : pas de fichier à la racine, et pas de renommage ou déplacement des dossiers de premier niveau par un client autre que l'appli de bureau.

## Installation

Prérequis : bun et npm. Le dépôt est attendu dans `~/dev/proton-sync`.

    cd ~/dev/proton-sync
    scripts/install.sh

Le script installe les dépendances, applique `scripts/patch-crypto.sh`, crée le lien
`~/.local/bin/proton-sync` et copie le fichier de service (launchd sur macOS, systemd sur Linux).
Il ne démarre rien : il affiche la commande à lancer. Il peut être relancé sans risque.

Ensuite :

    proton-sync login
    proton-sync init <dossier> <device:nom/dossier|root>
    proton-sync plan

Pour passer de rclone à proton-sync, suivre `docs/migration.md`.

## Intégration continue

GitHub Actions (`.github/workflows/ci.yml`, ubuntu seul, bun 1.4.2) lance sur chaque push vers `main` et chaque pull request : les tests (`local`, `scenarios`, `integration`, `proton-adapter`), le fuzz, puis `tsc --noEmit` qui échoue sur toute erreur dans `src/` ou `test/`.
Aucun accès à Proton, au trousseau ni au réseau n'est nécessaire. Pour reproduire en local, lancer les commandes de `CLAUDE.md` (section Commandes).

## Commandes

- `init <dossier> <device:nom/dossier|root>` : écrit la configuration.
- `login` / `logout` : connexion et déconnexion à Proton.
- `plan` : affiche ce qui serait fait, sans rien modifier.
- `once` : une seule passe de synchronisation.
- `run` : démon, synchronisation continue.
- `approve` : approuve les grosses suppressions mises en attente.
- `status` : état de la dernière passe.
- `version` : version.

## Configuration

Fichier `config.json`, dans `~/.local/share/proton-sync` par défaut. `proton-sync init` l'écrit, sauf `allowDriveRoot`, à ajouter à la main.

| Option | Obligatoire | Rôle |
| --- | --- | --- |
| `localRoot` | oui | Dossier local synchronisé. Il doit contenir le marqueur `.proton-sync-root`, créé par `init`. |
| `remote` | oui | Cible sur le Drive : `device:<nom>/<dossier>` pour un espace isolé, `root` pour Mes fichiers. |
| `deviceName` | oui | Nom de la machine, repris dans le nom des copies de conflit et des fichiers temporaires. `init` le déduit du nom d'hôte. |
| `maxDeletes` | oui | Au-delà de ce nombre de fichiers supprimés en une passe, les suppressions sont retenues jusqu'à `proton-sync approve`. `init` met 20. |
| `allowDriveRoot` | seulement avec `root` | Doit valoir `true` pour accepter `remote: "root"`. Sans lui, toute commande qui vise Mes fichiers s'arrête avant d'accéder au Drive. Cette seconde confirmation évite de lancer un test sur le vrai Drive. Ignoré pour une cible `device:`. |
| `verbose` | non | `true` pour un journal détaillé : chaque événement de surveillance, la cause de chaque passe (changement local, sondage du Drive…) et sa durée. Produit une ligne par minute même au repos. Défaut : `false`. |

Exemple pour Mes fichiers :

    {
        "localRoot": "/Users/steph/ProtonSync",
        "remote": "root",
        "deviceName": "MacBook-Air-de-alice",
        "maxDeletes": 20,
        "allowDriveRoot": true
    }

Variables d'environnement :

- `PROTON_SYNC_HOME` : dossier des données (config, base, journal, quarantaine).
- `PROTON_SYNC_CONFIG` : chemin du fichier de configuration, si différent.

Chaque cible a besoin de son propre `PROTON_SYNC_HOME` : la base garde en mémoire les fichiers déjà synchronisés. Avec une base d'une autre cible, ses fichiers paraîtraient supprimés.

## Où sont les fichiers

- Données : `~/.local/share/proton-sync` (changer avec `PROTON_SYNC_HOME`). Contient `config.json`, la base SQLite et `proton-sync.log`.
- Quarantaine : `~/.local/share/proton-sync/quarantine`.
- Journal du service sur macOS : `~/Library/Logs/proton-sync.log`. Sur Linux : `journalctl --user -u proton-sync`.

## Récupérer un fichier

Quarantaine : toute suppression ou tout écrasement local y passe d'abord. Parcourir
`~/.local/share/proton-sync/quarantine`, puis copier le fichier voulu à sa place dans `~/Proton`.

Corbeille Proton : ouvrir Proton Drive sur le web, section Corbeille, sélectionner l'élément et le restaurer.
Proton Drive ne l'efface définitivement qu'après son délai de rétention. proton-sync ne vide jamais la corbeille.

## Limites

- Une suppression voulue par l'utilisateur est propagée : elle reste récupérable via corbeille et quarantaine.
- La synchro n'est pas une sauvegarde indépendante.
- Le SDK n'est pas encore garanti pour un usage tiers en production.

Autre limite : les miniatures ne sont pas générées pour les images envoyées.
Les Docs et tableurs Proton natifs ne sont jamais synchronisés.
