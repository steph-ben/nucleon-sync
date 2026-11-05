# proton-sync : conception

Démon de synchronisation bidirectionnelle `~/Proton` <-> Proton Drive, pour macOS 12 Intel et Linux.
Remplace `rclone bisync`. Client tiers à usage personnel, identifié `external-drive-protonsync`.

## Priorités

1. Rien ne se perd.
2. Renommer ou déplacer un répertoire est une seule opération, quelle que soit sa taille.
3. Quasi temps réel, sobre en bande passante (connexion mobile).

## Principe : fusion à trois états

- **Base** : le dernier état commun connu (SQLite), un enregistrement par élément synchronisé.
- **Local** : scan du disque. Identité = inode.
- **Distant** : miroir tenu à jour par les événements Drive. Identité = UID de nœud.

Chaque élément est suivi par (parent, nom), pas par chemin complet : renommer un dossier change
un seul enregistrement, ses descendants ne bougent pas. `reconcile(base, local, distant)` est une
fonction pure qui retourne un plan. La reprise après coupure ne demande rien de spécial : la base
n'avance qu'après chaque action réussie, et la prochaine passe recalcule depuis l'état réel.

## Règles de conflit (aucune ne détruit de contenu)

| Local | Distant | Résultat |
|---|---|---|
| modifié | modifié, contenu identique | rien à faire |
| modifié | modifié, contenu différent | les deux gardés : copie de conflit locale envoyée |
| supprimé | modifié | le fichier distant revient en local |
| modifié | supprimé | le fichier local est renvoyé |
| déplacé | déplacé ailleurs | le distant gagne, c'est seulement un nom |
| déplacé | supprimé | le déplacement gagne |
| dossier supprimé | contenu ajouté ou modifié dedans | le dossier reste avec ce contenu |
| créé | créé au même endroit, contenu différent | les deux gardés |

## Garanties structurelles

- `RemoteFs` n'expose ni suppression définitive ni vidage de corbeille : le code ne peut pas les appeler.
- Toute suppression ou tout écrasement local passe d'abord par la quarantaine.
- Écriture locale atomique : fichier temporaire, vérification, puis renommage.
- Avant toute action locale, l'élément est revérifié ; s'il a changé, l'action est abandonnée.
- Racine absente, sans marqueur, ou scan vide alors que la base ne l'est pas : arrêt.
- Grosses suppressions réelles : mises en attente d'une approbation, le reste continue.
- Premier lancement (base vide) : aucune suppression possible, appariement par chemin et contenu.
- Docs et tableurs Proton, et noms indéchiffrables : jamais synchronisés ni touchés. Un dossier qui en
  contient n'est jamais mis à la corbeille.
- Liens symboliques : ignorés, jamais suivis.

## Limites

- Une suppression voulue par l'utilisateur est propagée : elle reste récupérable via corbeille et quarantaine.
- La synchro n'est pas une sauvegarde indépendante.
- Le SDK n'est pas encore garanti pour un usage tiers en production.
