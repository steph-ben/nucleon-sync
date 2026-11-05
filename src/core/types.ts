export type Kind = 'file' | 'dir';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type Logger = (level: LogLevel, message: string) => void;

export const ROOT = '__root__';

/** Transient name during a name swap, ignored by scanners. */
export const SWAP_PREFIX = '.proton-sync-swap-';

/** An item seen on one side. `parent` is an id on the same side, or ROOT. */
export interface Entry {
    id: string;
    parent: string;
    name: string;
    kind: Kind;
    size: number;
    mtime: number;
    /** Local side: inode change time. Catches edits that keep size and modification date. */
    ctime?: number;
    /** SHA-1 hex of the content. Remote side: may be missing if Proton does not report it. */
    hash?: string;
    /** Remote side: revision id. */
    rev?: string;
    /**
     * Item that is present but must never be synced or touched: Proton doc, Proton sheet,
     * undecryptable name. It counts as preventing deletion of its parent folder.
     */
    protected?: boolean;
}

export type Snapshot = Map<string, Entry>;

/** Last known common state of an item. */
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
    /** Missing in records written before this field existed. */
    localCtime?: number;
    rev?: string;
}

/** Reference to a parent folder that may not exist yet on the other side. */
export type Ref =
    | { t: 'root' }
    | { t: 'rec'; key: string }
    | { t: 'newLocal'; id: string }
    | { t: 'newRemote'; id: string };

export type Action =
    /** The local folder or file becomes a conflict copy, to keep both versions. */
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
    /** Updates the base without transferring anything. Without `content`, only the position changes. */
    | { t: 'refresh'; key: string; content: boolean }
    /**
     * Forgets the record: the item is gone from both sides, or becomes a new item again.
     * With `ifGone`, only if that ancestor was actually deleted in the same pass.
     */
    | { t: 'forget'; key: string; ifGone?: string }
    | { t: 'remoteTrash'; key: string }
    | { t: 'localQuarantine'; key: string };

export interface Plan {
    /** Records whose item changed id at the same location. */
    rebinds: { key: string; localId: string; remoteId: string }[];
    actions: Action[];
    /** Deletions held back, awaiting approval. */
    held: Action[];
    /** Why deletions are held: only 'limit' can be lifted with `approve`. */
    heldReason?: 'limit' | 'incomplete-scan';
    warnings: string[];
}

export interface ReconcileOptions {
    deviceName: string;
    /** Today's date as YYYY-MM-DD, passed in as a parameter to keep the function pure. */
    today: string;
    /** Local file system is case-insensitive (macOS default). */
    caseInsensitive: boolean;
    /** Above this, real deletions wait for approval. */
    maxDeletes: number;
    /** Approval granted for this pass. */
    approveDeletes?: boolean;
    /** The local scan is incomplete: no deletion in this pass, approved or not. */
    blockDeletes?: boolean;
}
