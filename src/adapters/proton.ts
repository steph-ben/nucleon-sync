import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { DriveEventType, type MaybeMissingNode, type NodeEntity, NodeType, NodeWithSameNameExistsValidationError, type ProtonDriveClient } from '@protontech/drive-sdk';

import { PathBusy, type RemoteFs, type Source } from '../core/interfaces';
import { type Entry, type Logger, ROOT, type Snapshot } from '../core/types';

const PROTON_NATIVE = /^application\/vnd\.proton\./;

export interface KvStore {
    getKv(key: string): string | undefined;
    setKv(key: string, value: string): void;
}

interface Mirror {
    eventId: string;
    entries: Entry[];
}

/** Subset of the SDK used here: no `deleteNodes`, no `emptyTrash`, no deletable revisions. */
export type DriveApi = Pick<
    ProtonDriveClient,
    | 'iterateEvents'
    | 'iterateFolderChildren'
    | 'iterateNodes'
    | 'createFolder'
    | 'moveNodes'
    | 'renameNode'
    | 'trashNodes'
    | 'getFileUploader'
    | 'getFileRevisionUploader'
    | 'getFileDownloader'
    | 'getNode'
>;

/** Converts an SDK node. Anything not safe to sync becomes protected. */
export function toEntry(node: NodeEntity, rootUid: string): Entry {
    const parent = !node.parentUid || node.parentUid === rootUid ? ROOT : node.parentUid;
    const isFile = node.type === NodeType.File;
    const isFolder = node.type === NodeType.Folder;
    const native = !!node.mediaType && PROTON_NATIVE.test(node.mediaType);
    // `errors`: partially decrypted node, its fields are not reliable.
    const nameOk = node.name.ok && !node.errors?.length;
    const revision = node.activeRevision;
    return {
        id: node.uid,
        parent,
        name: nameOk ? (node.name as { ok: true; value: string }).value : `__unreadable__${node.uid}`,
        kind: isFolder ? 'dir' : 'file',
        size: revision?.claimedSize ?? revision?.storageSize ?? 0,
        mtime: (revision?.claimedModificationTime ?? node.modificationTime).getTime(),
        hash: isFile ? revision?.claimedDigests?.sha1?.toLowerCase() : undefined,
        rev: isFile ? revision?.uid : undefined,
        protected: !nameOk || native || !(isFile || isFolder),
    };
}

function mapBusy(e: unknown): unknown {
    return e instanceof NodeWithSameNameExistsValidationError ? new PathBusy(e.message) : e;
}

/**
 * The Drive as seen by the engine, limited to the subtree of `rootUid`.
 *
 * The local mirror avoids re-walking the tree: it is kept up to date through events. It is
 * saved after each daemon action, before the engine advances its base: otherwise a file that
 * was just uploaded would look deleted remotely until the event arrives.
 */
export class ProtonRemote implements RemoteFs {
    private entries = new Map<string, Entry>();
    private eventId: string | undefined;
    private loaded = false;

    constructor(
        private sdk: DriveApi,
        private rootUid: string,
        private scopeId: string,
        private kv: KvStore,
        private log: Logger = () => {},
        /** The engine uses paths relative to the local root. */
        private absolute: (rel: string) => string = (p) => p,
        /** Same exclusions as locally: otherwise a .DS_Store on the Drive would be downloaded again endlessly. */
        private ignore: (name: string, isDir: boolean) => boolean = () => false,
    ) {}

    private load() {
        if (this.loaded) return;
        this.loaded = true;
        const raw = this.kv.getKv(`mirror:${this.rootUid}`);
        if (!raw) return;
        const m = JSON.parse(raw) as Mirror;
        this.eventId = m.eventId;
        this.entries = new Map(m.entries.map((e) => [e.id, e]));
    }

    private save() {
        if (!this.eventId) return;
        const value: Mirror = { eventId: this.eventId, entries: [...this.entries.values()] };
        this.kv.setKv(`mirror:${this.rootUid}`, JSON.stringify(value));
    }

    private dropSubtree(id: string) {
        this.entries.delete(id);
        for (const e of [...this.entries.values()]) if (e.parent === id) this.dropSubtree(e.id);
    }

    private async walk(folder: string) {
        const found: string[] = [];
        for await (const child of this.sdk.iterateFolderChildren(folder)) {
            const e = toEntry(child, this.rootUid);
            this.entries.set(e.id, e);
            if (e.kind === 'dir' && !e.protected) found.push(e.id);
        }
        for (const id of found) await this.walk(id);
    }

    private async fullWalk() {
        this.log('INFO', 'reading the whole Drive tree (first run or Drive asked for a refresh)');
        const previous = this.entries;
        this.entries = new Map();
        try {
            await this.walk(this.rootUid);
        } catch (e) {
            // Incomplete walk: keep the old mirror, never a partial one.
            this.entries = previous;
            throw e;
        }
    }

    private async refreshNode(uid: string) {
        let found: MaybeMissingNode | undefined;
        for await (const n of this.sdk.iterateNodes([uid])) found = n as MaybeMissingNode;
        if (!found || ('missingUid' in found && found.missingUid)) {
            this.dropSubtree(uid);
            return;
        }
        const raw = found as NodeEntity;
        const known = this.entries.has(uid);
        const inScope = raw.parentUid === this.rootUid || (!!raw.parentUid && this.entries.has(raw.parentUid));
        if (raw.trashTime || !inScope) {
            this.dropSubtree(uid);
            return;
        }
        const e = toEntry(raw, this.rootUid);
        this.entries.set(uid, e);
        if (!known && e.kind === 'dir' && !e.protected) await this.walk(uid);
    }

    async snapshot(): Promise<Snapshot> {
        this.load();
        if (!this.eventId) {
            // Event id first: whatever changes during the walk will be replayed.
            for await (const ev of this.sdk.iterateEvents(this.scopeId)) this.eventId = ev.eventId;
            await this.fullWalk();
            this.save();
        } else {
            let changed = false;
            let seen = 0;
            for await (const ev of this.sdk.iterateEvents(this.scopeId, this.eventId)) {
                changed = true;
                seen++;
                switch (ev.type) {
                    case DriveEventType.NodeCreated:
                    case DriveEventType.NodeUpdated:
                        if (ev.isTrashed) this.dropSubtree(ev.nodeUid);
                        else await this.refreshNode(ev.nodeUid);
                        break;
                    case DriveEventType.NodeDeleted:
                        this.dropSubtree(ev.nodeUid);
                        break;
                    case DriveEventType.TreeRefresh:
                        await this.fullWalk();
                        break;
                    case DriveEventType.TreeRemove:
                        throw new Error('Drive volume removed: stopping');
                    default:
                        break;
                }
                if (ev.eventId !== 'none') this.eventId = ev.eventId;
            }
            if (changed) this.save();
            this.log('DEBUG', `Drive: ${seen} event(s) since the last poll`);
        }
        return this.visible();
    }

    private visible(): Snapshot {
        const ignored = (e: Entry | undefined): boolean => {
            for (let c = e; c; c = this.entries.get(c.parent)) if (!c.protected && this.ignore(c.name, c.kind === 'dir')) return true;
            return false;
        };
        return new Map([...this.entries.values()].filter((e) => !ignored(e)).map((e) => [e.id, { ...e }]));
    }

    private uid(id: string) {
        return id === ROOT ? this.rootUid : id;
    }

    private remember(n: NodeEntity): Entry {
        const e = toEntry(n, this.rootUid);
        this.entries.set(e.id, e);
        this.save();
        return { ...e };
    }

    async mkdir(parentId: string, name: string): Promise<Entry> {
        try {
            return this.remember(await this.sdk.createFolder(this.uid(parentId), name));
        } catch (e) {
            throw mapBusy(e);
        }
    }

    async move(id: string, newParentId: string, newName: string): Promise<Entry> {
        const current = this.entries.get(id);
        const parent = this.uid(newParentId);
        try {
            if (!current || current.parent !== newParentId) {
                for await (const r of this.sdk.moveNodes([id], parent)) if (!r.ok) throw r.error;
            }
            if (!current || current.name !== newName) return this.remember(await this.sdk.renameNode(id, newName));
            return this.remember(await this.sdk.getNode(id));
        } catch (e) {
            throw mapBusy(e);
        }
    }

    private stream(path: string): ReadableStream {
        return Readable.toWeb(createReadStream(this.absolute(path))) as unknown as ReadableStream;
    }

    private metadata(source: Source, hash: string | undefined) {
        return {
            mediaType: 'application/octet-stream',
            expectedSize: source.size,
            expectedSha1: hash,
            modificationTime: new Date(source.mtime),
        };
    }

    async upload(parentId: string, name: string, localPath: string, source: Source, expectedHash: string | undefined): Promise<Entry> {
        try {
            const uploader = await this.sdk.getFileUploader(this.uid(parentId), name, this.metadata(source, expectedHash));
            const controller = await uploader.uploadFromStream(this.stream(localPath), []);
            const { nodeUid } = await controller.completion();
            return this.remember(await this.sdk.getNode(nodeUid));
        } catch (e) {
            throw mapBusy(e);
        }
    }

    async uploadRevision(id: string, localPath: string, source: Source, expectedHash: string | undefined): Promise<Entry> {
        const uploader = await this.sdk.getFileRevisionUploader(id, this.metadata(source, expectedHash));
        const controller = await uploader.uploadFromStream(this.stream(localPath), []);
        await controller.completion();
        return this.remember(await this.sdk.getNode(id));
    }

    async download(id: string, tmpPath: string): Promise<void> {
        const downloader = await this.sdk.getFileDownloader(id);
        const file = Bun.file(tmpPath);
        const writer = file.writer();
        const stream = {
            getWriter: () => writer,
            close: async () => {
                await writer.end();
            },
            abort: async () => {
                await writer.end();
            },
            locked: false,
        } as unknown as WritableStream;
        const controller = downloader.downloadToStream(stream);
        await controller.completion();
        await writer.end();
        if (controller.isDownloadCompleteWithSignatureIssues()) this.log('WARN', `downloaded file has a signature issue (kept anyway): ${id}`);
    }

    async trash(id: string): Promise<void> {
        for await (const r of this.sdk.trashNodes([id])) if (!r.ok) throw r.error;
        this.dropSubtree(id);
        this.save();
    }
}
