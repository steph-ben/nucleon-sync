import type { BaseRec, Entry, Snapshot } from './types';

/** The target name is busy: resolves on the next pass, harmless. */
export class PathBusy extends Error {}

/** A local file being read for upload. The real hash is verified during the read. */
export interface Source {
    size: number;
    mtime: number;
}

export interface LocalFs {
    /** Fails if the root is missing or has no marker. */
    assertRootSafe(): Promise<void>;
    /**
     * Whatever the last scan could not read. Non-empty means the snapshot is incomplete: an item
     * missing from it may still exist, so its absence proves nothing.
     */
    scanWarnings: string[];
    /** `known` allows reusing hashes of unchanged files. */
    scan(known: Map<string, BaseRec>): Promise<Snapshot>;
    mkdir(path: string): Promise<Entry>;
    /** Renames without ever overwriting: fails if the destination exists. */
    move(from: string, to: string): Promise<void>;
    /** True if the file or folder still matches what was scanned. */
    isUnchanged(path: string, entry: Entry): Promise<boolean>;
    /** Moves to quarantine, destroying nothing. */
    quarantine(path: string): Promise<void>;
    /** Prepares a file for upload. */
    openSource(path: string): Promise<Source>;
    /** Writes via a temp file then renames; fails if the destination exists. */
    writeFile(
        path: string,
        expectedHash: string | undefined,
        mtime: number,
        fill: (tmpPath: string) => Promise<void>,
        /** Called once the content is complete and verified, just before putting it in place. */
        beforeInstall?: () => Promise<void>,
    ): Promise<Entry>;
}

/** Deliberately has no permanent deletion or trash emptying. */
export interface RemoteFs {
    snapshot(): Promise<Snapshot>;
    mkdir(parentId: string, name: string): Promise<Entry>;
    move(id: string, newParentId: string, newName: string): Promise<Entry>;
    upload(parentId: string, name: string, localPath: string, source: Source, expectedHash: string | undefined): Promise<Entry>;
    uploadRevision(id: string, localPath: string, source: Source, expectedHash: string | undefined): Promise<Entry>;
    download(id: string, tmpPath: string): Promise<void>;
    trash(id: string): Promise<void>;
}

export interface Store {
    all(): BaseRec[];
    put(rec: BaseRec): void;
    remove(key: string): void;
}
