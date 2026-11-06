import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { defaultIgnore, RealLocalFs } from '../src/adapters/local';
import { Engine } from '../src/core/engine';
import { ROOT } from '../src/core/types';
import { Hub } from './sim';
import { allFiles, cleanWorlds, FakeDrive, machine, settle, tree } from './lib/world';

afterEach(cleanWorlds);

describe('two machines, real files', () => {
    test('renaming a folder propagates without transfer, and the inode on side B is kept', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        const b = machine('B', hub);
        mkdirSync(path.join(a.root, 'Music/Piano'), { recursive: true });
        writeFileSync(path.join(a.root, 'Music/Piano/f.txt'), 'partition');
        await settle(a, b);
        expect(tree(b.root)).toEqual({ 'Music/Piano/f.txt': 'partition' });
        const before = Bun.file(path.join(b.root, 'Music/Piano/f.txt')).lastModified;

        renameSync(path.join(a.root, 'Music'), path.join(a.root, 'Musique'));
        await settle(a, b);
        expect(tree(b.root)).toEqual({ 'Musique/Piano/f.txt': 'partition' });
        expect(Bun.file(path.join(b.root, 'Musique/Piano/f.txt')).lastModified).toBe(before);
    });

    test('deletion: the content is in quarantine on the other machine and in the trash', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        const b = machine('B', hub);
        writeFileSync(path.join(a.root, 'letter.txt'), 'précieux');
        await settle(a, b);
        rmSync(path.join(a.root, 'letter.txt'));
        await settle(a, b);
        expect(tree(b.root)).toEqual({});
        expect(allFiles(b.quarantine)).toContain('précieux');
        expect([...hub.nodes.values()][0]!.trashed).toBe(true);
    });

    test('atomic editor save (new inode): new revision, no deletion', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        writeFileSync(path.join(a.root, 'doc.txt'), 'v1');
        await settle(a);
        writeFileSync(path.join(a.root, 'doc.txt.tmp'), 'v2');
        renameSync(path.join(a.root, 'doc.txt.tmp'), path.join(a.root, 'doc.txt'));
        await settle(a);
        const nodes = [...hub.nodes.values()].filter((n) => n.name === 'doc.txt');
        expect(nodes.length).toBe(1);
        expect(nodes[0]!.revisions).toEqual(['v1', 'v2']);
    });

    test('real conflict: both versions on both machines', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        const b = machine('B', hub);
        writeFileSync(path.join(a.root, 'n.txt'), 'base');
        await settle(a, b);
        writeFileSync(path.join(a.root, 'n.txt'), 'version A');
        writeFileSync(path.join(b.root, 'n.txt'), 'version B');
        await settle(a, b);
        expect(tree(a.root)).toEqual(tree(b.root));
        expect(Object.values(tree(a.root)).sort()).toEqual(['version A', 'version B']);
    });

    test('.DS_Store, .venv and symlinks are not uploaded', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        const outside = path.join(a.root, '..', 'secret.txt');
        writeFileSync(outside, 'outside root');
        writeFileSync(path.join(a.root, '.DS_Store'), 'x');
        mkdirSync(path.join(a.root, '.venv'));
        writeFileSync(path.join(a.root, '.venv/lib'), 'x');
        symlinkSync(outside, path.join(a.root, 'link'));
        writeFileSync(path.join(a.root, 'real.txt'), 'ok');
        await settle(a);
        expect(hub.tree()).toEqual({ 'real.txt': 'ok' });
    });

    test('empty file: synced, unlike rclone with --min-size', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        const b = machine('B', hub);
        writeFileSync(path.join(a.root, 'hello'), '');
        await settle(a, b);
        expect(existsSync(path.join(b.root, 'hello'))).toBe(true);
    });

    test('resume after stop: a new instance restarts from the base without re-transferring anything', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        writeFileSync(path.join(a.root, 'f'), 'x');
        await settle(a);
        const local = new RealLocalFs(a.root, a.quarantine, { ignore: defaultIgnore });
        const again = new Engine(local, new FakeDrive(hub, a.root), a.store, { deviceName: 'A', caseInsensitive: false, maxDeletes: 20, newKey: () => 'n', today: () => '2026-11-05' });
        expect((await again.planOnly()).actions).toEqual([]);
    });

    test('modification date only: no upload', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        writeFileSync(path.join(a.root, 'f'), 'x');
        await settle(a);
        utimesSync(path.join(a.root, 'f'), new Date(5000), new Date(5000));
        const r = await a.engine.cycle();
        expect(r.plan.actions.map((x) => x.t)).toEqual(['refresh']);
        expect([...hub.nodes.values()][0]!.revisions.length).toBe(1);
    });

    test('local folder without marker: no action', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        writeFileSync(path.join(a.root, 'f'), 'x');
        await settle(a);
        rmSync(path.join(a.root, '.nucleon-sync-root'));
        await expect(a.engine.cycle()).rejects.toThrow();
        expect(hub.tree()).toEqual({ f: 'x' });
        void copyFileSync;
    });
});

void ROOT;

/**
 * An item that cannot be read is not an item that was deleted. Losing read access (permissions,
 * disk error, privacy settings) must never be propagated as a deletion.
 */
describe('unreadable items are not deletions', () => {
    async function twoMachines() {
        const hub = new Hub();
        const a = machine('A', hub);
        const b = machine('B', hub);
        mkdirSync(path.join(a.root, 'Papiers'));
        writeFileSync(path.join(a.root, 'Papiers/impots.pdf'), 'impots');
        writeFileSync(path.join(a.root, 'Papiers/passeport.pdf'), 'passeport');
        writeFileSync(path.join(a.root, 'autre.txt'), 'autre');
        await settle(a, b);
        return { hub, a, b };
    }
    const locked: string[] = [];
    const lock = (p: string) => {
        locked.push(p);
        chmodSync(p, 0);
    };
    const unlockAll = () => {
        for (const p of locked.splice(0)) chmodSync(p, 0o755);
    };
    afterEach(unlockAll);

    test('unreadable folder: its files stay on the Drive and on the other machine, with a warning', async () => {
        const { hub, a, b } = await twoMachines();
        lock(path.join(a.root, 'Papiers'));
        const r = await a.engine.cycle();
        expect(r.plan.actions.filter((x) => x.t === 'remoteTrash' || x.t === 'localQuarantine')).toEqual([]);
        expect(r.plan.warnings.join('\n')).toContain('Papiers');
        await b.engine.cycle();
        expect(tree(b.root)['Papiers/impots.pdf']).toBe('impots');
        expect(allFiles(b.quarantine)).toEqual([]);
        unlockAll();
        await settle(a, b);
        expect(tree(a.root)).toEqual(tree(b.root));
        expect(hub.tree()['Papiers/impots.pdf']).toBe('impots');
    });

    test('approval does not bypass the protection', async () => {
        const { a } = await twoMachines();
        lock(path.join(a.root, 'Papiers'));
        const r = await a.engine.cycle(true);
        expect(r.plan.actions.filter((x) => x.t === 'remoteTrash')).toEqual([]);
        expect(r.plan.heldReason).toBe('incomplete-scan');
    });

    test('file edited then unreadable: stays on the Drive, and the edit is uploaded once readable', async () => {
        const { a, b } = await twoMachines();
        const f = path.join(a.root, 'Papiers/impots.pdf');
        writeFileSync(f, 'impots version 2');
        lock(f);
        const r = await a.engine.cycle();
        expect(r.plan.actions.filter((x) => x.t === 'remoteTrash')).toEqual([]);
        expect(r.plan.warnings.join('\n')).toContain('impots.pdf');
        unlockAll();
        await settle(a, b);
        expect(tree(b.root)['Papiers/impots.pdf']).toBe('impots version 2');
    });

    test('unreadable file edited on the Drive: the local content is not overwritten', async () => {
        const { a, b } = await twoMachines();
        const f = path.join(a.root, 'Papiers/impots.pdf');
        writeFileSync(f, 'local edit');
        lock(f);
        writeFileSync(path.join(b.root, 'Papiers/impots.pdf'), 'edit from the other machine');
        await b.engine.cycle();
        await a.engine.cycle();
        unlockAll();
        await settle(a, b);
        expect(Object.values(tree(a.root)).sort()).toEqual(expect.arrayContaining(['edit from the other machine', 'local edit']));
        expect(tree(a.root)).toEqual(tree(b.root));
    });

    test('a real deletion elsewhere waits for a complete scan, then goes through', async () => {
        const { a, b } = await twoMachines();
        rmSync(path.join(a.root, 'autre.txt'));
        lock(path.join(a.root, 'Papiers'));
        const r = await a.engine.cycle();
        expect(r.plan.actions.filter((x) => x.t === 'remoteTrash')).toEqual([]);
        await b.engine.cycle();
        expect(tree(b.root)['autre.txt']).toBe('autre');
        unlockAll();
        await settle(a, b);
        expect(tree(b.root)['autre.txt']).toBeUndefined();
        expect(allFiles(b.quarantine)).toEqual(['autre']);
    });
});
