import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DriveEventType, NodeType } from '@protontech/drive-sdk';

import { type DriveApi, ProtonRemote, toEntry } from '../src/adapters/proton';
import { ROOT } from '../src/core/types';

const ROOT_UID = 'root';

function node(uid: string, parentUid: string, name: string, extra: Record<string, unknown> = {}) {
    return { uid, parentUid, name: { ok: true, value: name }, type: NodeType.File, modificationTime: new Date(1000), activeRevision: { uid: `${uid}-r1`, storageSize: 9, claimedSize: 3, claimedDigests: { sha1: 'ABC', sha1Verified: true } }, ...extra };
}
const folder = (uid: string, parentUid: string, name: string) => node(uid, parentUid, name, { type: NodeType.Folder, activeRevision: undefined });

class FakeDrive {
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

function setup() {
    const drive = new FakeDrive();
    const kv = new Map<string, string>();
    const remote = new ProtonRemote(drive as unknown as DriveApi, ROOT_UID, 's', { getKv: (k) => kv.get(k), setKv: (k, v) => void kv.set(k, v) }, () => {}, (p) => p);
    return { drive, kv, remote };
}

describe('toEntry', () => {
    test('doc et tableur Proton sont protégés', () => {
        expect(toEntry(node('d', ROOT_UID, 'Plop', { mediaType: 'application/vnd.proton.doc' }) as any, ROOT_UID).protected).toBe(true);
        expect(toEntry(node('s', ROOT_UID, 'Thuna', { mediaType: 'application/vnd.proton.sheet' }) as any, ROOT_UID).protected).toBe(true);
    });
    test('nom indéchiffrable et nœud dégradé sont protégés', () => {
        expect(toEntry(node('x', ROOT_UID, 'x', { name: { ok: false, error: new Error('e') } }) as any, ROOT_UID).protected).toBe(true);
        expect(toEntry(node('y', ROOT_UID, 'y', { errors: [new Error('e')] }) as any, ROOT_UID).protected).toBe(true);
    });
    test('fichier normal : empreinte en minuscules, parent racine', () => {
        const e = toEntry(node('f', ROOT_UID, 'f') as any, ROOT_UID);
        expect(e).toMatchObject({ parent: ROOT, hash: 'abc', rev: 'f-r1', size: 3 });
        expect(e.protected).toBe(false);
    });
});

describe('miroir', () => {
    test('un fichier envoyé est dans le miroir sans attendre son événement', async () => {
        const { remote } = setup();
        await remote.snapshot();
        const dir = mkdtempSync(path.join(tmpdir(), 'ps-'));
        const file = path.join(dir, 'a');
        writeFileSync(file, 'abc');
        const e = await remote.upload(ROOT, 'a', file, { size: 3, mtime: 1 }, undefined);
        expect((await remote.snapshot()).has(e.id)).toBe(true);
        expect(readFileSync(file, 'utf8')).toBe('abc');
    });

    test('un seul parcours complet : ensuite, uniquement les événements', async () => {
        const { drive, remote } = setup();
        drive.add(folder('d', ROOT_UID, 'D'));
        await remote.snapshot();
        const walks = drive.calls.length;
        drive.add(node('n', 'd', 'neuf'));
        drive.events.push({ type: DriveEventType.NodeCreated, nodeUid: 'n', parentNodeUid: 'd', isTrashed: false, isShared: false, treeEventScopeId: 's', eventId: 'e1' });
        const snap = await remote.snapshot();
        expect(snap.get('n')?.parent).toBe('d');
        expect(drive.calls.length).toBe(walks);
    });

    test('dossier mis à la corbeille : descendants retirés', async () => {
        const { drive, remote } = setup();
        drive.add(folder('d', ROOT_UID, 'D'));
        drive.add(node('f', 'd', 'f'));
        await remote.snapshot();
        drive.events.push({ type: DriveEventType.NodeUpdated, nodeUid: 'd', isTrashed: true, isShared: false, treeEventScopeId: 's', eventId: 'e1' });
        expect((await remote.snapshot()).size).toBe(0);
    });

    test('hors du sous-arbre : ignoré', async () => {
        const { drive, remote } = setup();
        drive.add(node('ailleurs', 'autre-dossier', 'x'));
        drive.events.push({ type: DriveEventType.NodeCreated, nodeUid: 'ailleurs', isTrashed: false, isShared: false, treeEventScopeId: 's', eventId: 'e1' });
        await remote.snapshot();
        expect((await remote.snapshot()).has('ailleurs')).toBe(false);
    });

    test('parcours initial en échec : aucun miroir partiel enregistré', async () => {
        const { drive, kv, remote } = setup();
        drive.iterateFolderChildren = async function* () {
            throw new Error('réseau');
        } as any;
        await expect(remote.snapshot()).rejects.toThrow('réseau');
        expect(kv.size).toBe(0);
    });
});

test('le code du démon ne contient aucune suppression définitive', async () => {
    const src = ['src/adapters/proton.ts', 'src/main.ts', 'src/core/engine.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const forbidden of ['deleteNodes', 'emptyTrash', 'deleteRevision', 'deleteDevice']) expect(src.includes(`.${forbidden}(`)).toBe(false);
});
