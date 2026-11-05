import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createRootMarker, defaultIgnore, RealLocalFs } from '../src/adapters/local';
import { SqliteStore } from '../src/adapters/sqlite-store';
import { Engine } from '../src/core/engine';
import type { RemoteFs, Source } from '../src/core/interfaces';
import { type Entry, ROOT } from '../src/core/types';
import { Hub } from './sim';

/** Shared fake Drive, reading and writing real files. The content also serves as the local hash. */
class FileRemote implements RemoteFs {
    constructor(
        private hub: Hub,
        private root: string,
    ) {}
    private sha(s: string) {
        return createHash('sha1').update(s).digest('hex');
    }
    private entry(id: string): Entry {
        const e = this.hub.entry(this.hub.nodes.get(id)!);
        return e.kind === 'file' ? { ...e, hash: this.sha(this.hub.nodes.get(id)!.content) } : e;
    }
    async snapshot() {
        const m = new Map<string, Entry>();
        for (const n of this.hub.nodes.values()) if (this.hub.alive(n)) m.set(n.id, this.entry(n.id));
        return m;
    }
    async mkdir(parent: string, name: string) {
        return this.entry(this.hub.add(parent, name, 'dir', '').id);
    }
    async move(id: string, parent: string, name: string) {
        this.hub.rename(id, parent, name);
        return this.entry(id);
    }
    async upload(parent: string, name: string, p: string, _s: Source) {
        return this.entry(this.hub.add(parent, name, 'file', readFileSync(path.join(this.root, p), 'utf8')).id);
    }
    async uploadRevision(id: string, p: string) {
        this.hub.edit(id, readFileSync(path.join(this.root, p), 'utf8'));
        return this.entry(id);
    }
    async download(id: string, tmp: string) {
        writeFileSync(tmp, this.hub.nodes.get(id)!.content);
    }
    async trash(id: string) {
        this.hub.trash(id);
    }
}

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function machine(tag: string, hub: Hub) {
    const home = mkdtempSync(path.join(tmpdir(), `proton-sync-it-${tag}-`));
    dirs.push(home);
    const root = path.join(home, 'Proton');
    mkdirSync(root);
    createRootMarker(root);
    const quarantine = path.join(home, 'quarantine');
    const store = new SqliteStore(path.join(home, 'state.sqlite'));
    const local = new RealLocalFs(root, quarantine, { ignore: defaultIgnore });
    let k = 0;
    const engine = new Engine(local, new FileRemote(hub, root), store, { deviceName: tag, caseInsensitive: false, maxDeletes: 20, newKey: () => `${tag}${++k}`, today: () => '2026-11-05' });
    return { root, quarantine, engine, store };
}

async function settle(...ms: ReturnType<typeof machine>[]) {
    for (let i = 0; i < 12; i++) {
        let work = 0;
        for (const m of ms) {
            const r = await m.engine.cycle();
            expect(r.errors).toEqual([]);
            work += r.plan.actions.length;
        }
        if (!work) return;
    }
    throw new Error('does not converge');
}

function tree(root: string, rel = ''): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
        if (e.name.startsWith('.proton-sync') || e.isSymbolicLink()) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) Object.assign(out, tree(root, p));
        else out[p] = readFileSync(path.join(root, p), 'utf8');
    }
    return out;
}

function allFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [readFileSync(path.join(dir, e.name), 'utf8')]));
}

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
        const again = new Engine(local, new FileRemote(hub, a.root), a.store, { deviceName: 'A', caseInsensitive: false, maxDeletes: 20, newKey: () => 'n', today: () => '2026-11-05' });
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
        rmSync(path.join(a.root, '.proton-sync-root'));
        await expect(a.engine.cycle()).rejects.toThrow();
        expect(hub.tree()).toEqual({ f: 'x' });
        void copyFileSync;
    });
});

void ROOT;
