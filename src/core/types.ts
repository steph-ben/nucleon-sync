export type Kind = 'file' | 'dir';

export const ROOT = '__root__';

/** Nom transitoire pendant un échange de noms, ignoré par les scanners. */
export const SWAP_PREFIX = '.proton-sync-swap-';

/** Un élément vu d'un côté. `parent` est un identifiant du même côté, ou ROOT. */
export interface Entry {
    id: string;
    parent: string;
    name: string;
    kind: Kind;
    size: number;
    mtime: number;
    /** SHA-1 hex du contenu. Côté distant : peut manquer si Proton ne le déclare pas. */
    hash?: string;
    /** Côté distant : identifiant de révision. */
    rev?: string;
    /**
     * Élément présent mais à ne jamais synchroniser ni toucher : doc Proton, tableur Proton,
     * nom indéchiffrable. Il compte pour empêcher la suppression de son dossier parent.
     */
    protected?: boolean;
}

export type Snapshot = Map<string, Entry>;

/** Dernier état commun connu d'un élément. */
export interface BaseRec {
    key: string;
    parent: string;
    name: string;
    kind: Kind;
    localId: string;
    remoteId: string;
    hash?: string;
    size: number;
    localMtime: number;
    rev?: string;
}

/** Référence vers un dossier parent qui peut ne pas encore exister de l'autre côté. */
export type Ref =
    | { t: 'root' }
    | { t: 'rec'; key: string }
    | { t: 'newLocal'; id: string }
    | { t: 'newRemote'; id: string };

export type Action =
    /** Le dossier ou fichier local devient une copie de conflit, pour garder les deux versions. */
    | { t: 'conflictRename'; localId: string; newName: string }
    | { t: 'remoteMkdir'; localId: string; parent: Ref; name: string }
    | { t: 'localMkdir'; remoteId: string; parent: Ref; name: string }
    | { t: 'link'; localId: string; remoteId: string }
    | { t: 'remoteMove'; key: string; parent: Ref; name: string }
    | { t: 'localMove'; key: string; parent: Ref; name: string }
    | { t: 'upload'; localId: string; parent: Ref; name: string }
    | { t: 'uploadRevision'; key: string }
    | { t: 'download'; remoteId: string; parent: Ref; name: string }
    | { t: 'downloadRevision'; key: string }
    /** Met la base à jour sans rien transférer. Sans `content`, seule la position change. */
    | { t: 'refresh'; key: string; content: boolean }
    /**
     * Oublie l'enregistrement : l'élément est parti des deux côtés, ou redevient un élément neuf.
     * Avec `ifGone`, seulement si cet ancêtre a bien été supprimé dans la même passe.
     */
    | { t: 'forget'; key: string; ifGone?: string }
    | { t: 'remoteTrash'; key: string }
    | { t: 'localQuarantine'; key: string };

export interface Plan {
    /** Enregistrements dont l'élément a changé d'identifiant au même endroit. */
    rebinds: { key: string; localId: string; remoteId: string }[];
    actions: Action[];
    /** Suppressions retenues, en attente d'approbation. */
    held: Action[];
    warnings: string[];
}

export interface ReconcileOptions {
    deviceName: string;
    /** Date du jour AAAA-MM-JJ, passée en paramètre pour garder la fonction pure. */
    today: string;
    /** Système de fichiers local insensible à la casse (macOS par défaut). */
    caseInsensitive: boolean;
    /** Au-delà, les suppressions réelles attendent une approbation. */
    maxDeletes: number;
    /** Approbation donnée pour cette passe. */
    approveDeletes?: boolean;
}
