import { NodeType, DriveEventType } from '@protontech/drive-sdk';

import { type DriveApi, ProtonRemote } from '../../src/adapters/proton';

export const ROOT_UID = 'root';

export function node(uid: string, parentUid: string, name: string, extra: Record<string, unknown> = {}) {
    return { uid, parentUid, name: { ok: true, value: name }, type: NodeType.File, modificationTime: new Date(1000), activeRevision: { uid: `${uid}-r1`, storageSize: 9, claimedSize: 3, claimedDigests: { sha1: 'ABC', sha1Verified: true } }, ...extra };
}
export const folder = (uid: string, parentUid: string, name: string) => node(uid, parentUid, name, { type: NodeType.Folder, activeRevision: undefined });

export class FakeSdk {
    nodes = new Map<string, any>();
    events: any[] = [];
    calls: string[] = [];
    add(n: any) {
        this.nodes.set(n.uid, n);
        return n;
    }
    async *iterateEvents(_s: string, last?: string) {
        if (!last) {
            yield { type: DriveEventType.FastForward, eventId: 'e0', treeEventScopeId: 's' };
            return;
        }
        for (const e of this.events.splice(0)) yield e;
    }
    async *iterateFolderChildren(uid: string) {
        this.calls.push(`walk:${uid}`);
        for (const n of this.nodes.values()) if (n.parentUid === uid && !n.trashTime) yield n;
    }
    async *iterateNodes(uids: string[]) {
        for (const u of uids) yield this.nodes.has(u) ? this.nodes.get(u) : { missingUid: u };
    }
    async getNode(uid: string) {
        return this.nodes.get(uid);
    }
    async createFolder(parentUid: string, name: string) {
        return this.add(folder(`new-${name}`, parentUid, name));
    }
    async *moveNodes(uids: string[], parent: string) {
        for (const u of uids) {
            this.nodes.get(u).parentUid = parent;
            yield { uid: u, ok: true };
        }
    }
    async renameNode(uid: string, name: string) {
        this.nodes.get(uid).name = { ok: true, value: name };
        return this.nodes.get(uid);
    }
    async *trashNodes(uids: string[]) {
        this.calls.push(`trash:${uids}`);
        for (const u of uids) {
            this.nodes.get(u).trashTime = new Date();
            yield { uid: u, ok: true };
        }
    }
    async getFileUploader(parent: string, name: string) {
        return {
            uploadFromStream: async (stream: ReadableStream) => {
                const body = await new Response(stream).text();
                const uid = `up-${name}`;
                this.add(node(uid, parent, name, { body }));
                return { completion: async () => ({ nodeUid: uid, nodeRevisionUid: `${uid}-r1` }) };
            },
        };
    }
}

export function setup() {
    const drive = new FakeSdk();
    const kv = new Map<string, string>();
    const remote = new ProtonRemote(drive as unknown as DriveApi, ROOT_UID, 's', { getKv: (k) => kv.get(k), setKv: (k, v) => void kv.set(k, v) }, () => {}, (p) => p);
    return { drive, kv, remote };
}

