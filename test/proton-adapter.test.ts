import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DriveEventType, NodeType } from '@protontech/drive-sdk';

import { ROOT } from '../src/core/types';
import { type DriveApi, ProtonRemote, toEntry } from '../src/adapters/proton';
import { FakeSdk, folder, node, ROOT_UID, setup } from './lib/fake-sdk';

describe('toEntry', () => {
    test('Proton doc and sheet are protected', () => {
        expect(toEntry(node('d', ROOT_UID, 'Plop', { mediaType: 'application/vnd.proton.doc' }) as any, ROOT_UID).protected).toBe(true);
        expect(toEntry(node('s', ROOT_UID, 'Thuna', { mediaType: 'application/vnd.proton.sheet' }) as any, ROOT_UID).protected).toBe(true);
    });
    test('undecryptable name and degraded node are protected', () => {
        expect(toEntry(node('x', ROOT_UID, 'x', { name: { ok: false, error: new Error('e') } }) as any, ROOT_UID).protected).toBe(true);
        expect(toEntry(node('y', ROOT_UID, 'y', { errors: [new Error('e')] }) as any, ROOT_UID).protected).toBe(true);
    });
    test('regular file: lowercase hash, root parent', () => {
        const e = toEntry(node('f', ROOT_UID, 'f') as any, ROOT_UID);
        expect(e).toMatchObject({ parent: ROOT, hash: 'abc', rev: 'f-r1', size: 3 });
        expect(e.protected).toBe(false);
    });
});

describe('mirror', () => {
    test('an uploaded file is in the mirror without waiting for its event', async () => {
        const { remote } = setup();
        await remote.snapshot();
        const dir = mkdtempSync(path.join(tmpdir(), 'ps-'));
        const file = path.join(dir, 'a');
        writeFileSync(file, 'abc');
        const e = await remote.upload(ROOT, 'a', file, { size: 3, mtime: 1 }, undefined);
        expect((await remote.snapshot()).has(e.id)).toBe(true);
        expect(readFileSync(file, 'utf8')).toBe('abc');
    });

    test('a single full walk: afterwards, events only', async () => {
        const { drive, remote } = setup();
        drive.add(folder('d', ROOT_UID, 'D'));
        await remote.snapshot();
        const walks = drive.calls.length;
        drive.add(node('n', 'd', 'new'));
        drive.events.push({ type: DriveEventType.NodeCreated, nodeUid: 'n', parentNodeUid: 'd', isTrashed: false, isShared: false, treeEventScopeId: 's', eventId: 'e1' });
        const snap = await remote.snapshot();
        expect(snap.get('n')?.parent).toBe('d');
        expect(drive.calls.length).toBe(walks);
    });

    test('folder moved to trash: descendants removed', async () => {
        const { drive, remote } = setup();
        drive.add(folder('d', ROOT_UID, 'D'));
        drive.add(node('f', 'd', 'f'));
        await remote.snapshot();
        drive.events.push({ type: DriveEventType.NodeUpdated, nodeUid: 'd', isTrashed: true, isShared: false, treeEventScopeId: 's', eventId: 'e1' });
        expect((await remote.snapshot()).size).toBe(0);
    });

    test('outside the subtree: ignored', async () => {
        const { drive, remote } = setup();
        drive.add(node('elsewhere', 'other-folder', 'x'));
        drive.events.push({ type: DriveEventType.NodeCreated, nodeUid: 'elsewhere', isTrashed: false, isShared: false, treeEventScopeId: 's', eventId: 'e1' });
        await remote.snapshot();
        expect((await remote.snapshot()).has('elsewhere')).toBe(false);
    });

    test('failed initial walk: no partial mirror saved', async () => {
        const { drive, kv, remote } = setup();
        drive.iterateFolderChildren = async function* () {
            throw new Error('network');
        } as any;
        await expect(remote.snapshot()).rejects.toThrow('network');
        expect(kv.size).toBe(0);
    });
});

test('exclusions also apply to the Drive, descendants included', async () => {
    const drive = new FakeSdk();
    const kv = new Map<string, string>();
    const ignore = (name: string) => name === '.DS_Store' || name === '.venv';
    const remote = new ProtonRemote(drive as unknown as DriveApi, ROOT_UID, 's', { getKv: (k) => kv.get(k), setKv: (k, v) => void kv.set(k, v) }, () => {}, (p) => p, ignore);
    drive.add(node('ds', ROOT_UID, '.DS_Store'));
    drive.add(folder('v', ROOT_UID, '.venv'));
    drive.add(node('lib', 'v', 'lib'));
    drive.add(node('ok', ROOT_UID, 'keep'));
    expect([...(await remote.snapshot()).keys()]).toEqual(['ok']);
});

test('the daemon code contains no permanent deletion', async () => {
    const src = ['src/adapters/proton.ts', 'src/main.ts', 'src/core/engine.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const forbidden of ['deleteNodes', 'emptyTrash', 'deleteRevision', 'deleteDevice']) expect(src.includes(`.${forbidden}(`)).toBe(false);
    const allowed = src.slice(src.indexOf('export type DriveApi = Pick<'), src.indexOf('>;', src.indexOf('export type DriveApi = Pick<')));
    expect(allowed).toContain('trashNodes');
    expect(allowed).not.toMatch(/'[^']*(delete|empty|purge)[^']*'/i);
});
