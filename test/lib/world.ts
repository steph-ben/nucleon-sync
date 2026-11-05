import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createRootMarker, defaultIgnore, RealLocalFs } from '../../src/adapters/local';
import { SqliteStore } from '../../src/adapters/sqlite-store';
import { Engine } from '../../src/core/engine';
import type { RemoteFs, Source } from '../../src/core/interfaces';
import { type Entry, ROOT } from '../../src/core/types';
import { Hub } from '../sim';

export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

export type DriveOp = 'snapshot' | 'mkdir' | 'move' | 'upload' | 'uploadRevision' | 'download' | 'trash';

/** Shared fake Drive, reading and writing real files. Faults are injected per operation. */
export class FakeDrive implements RemoteFs {
    private faults: { op: DriveOp; error: () => Error; times: number }[] = [];
    /** Called before each operation: crash points use this. */
    before: (op: DriveOp) => void = () => {};
    /** Called between reading a file and storing it: the user may edit it right then. */
    afterRead: () => void = () => {};
    /** Next downloads receive wrong content. */
    corruptDownloads = 0;
    /** The Drive no longer reports hashes, as for files written by old clients. */
    hideHashes = false;

    constructor(
        private hub: Hub,
        private root: string,
    ) {}

    /** The next `times` calls of `op` fail with this error. */
    fail(op: DriveOp, error: () => Error, times = 1) {
        this.faults.push({ op, error, times });
    }

    private gate(op: DriveOp) {
        this.before(op);
        const f = this.faults.find((x) => x.op === op && x.times > 0);
        if (f) {
            f.times--;
            throw f.error();
        }
    }
    private entry(id: string): Entry {
        const e = this.hub.entry(this.hub.nodes.get(id)!);
        if (e.kind !== 'file') return e;
        return { ...e, size: Buffer.byteLength(this.hub.nodes.get(id)!.content), hash: this.hideHashes ? undefined : sha1(this.hub.nodes.get(id)!.content) };
    }
    async snapshot() {
        this.gate('snapshot');
        const m = new Map<string, Entry>();
        for (const n of this.hub.nodes.values()) if (this.hub.alive(n)) m.set(n.id, this.entry(n.id));
        return m;
    }
    async mkdir(parent: string, name: string) {
        this.gate('mkdir');
        return this.entry(this.hub.add(parent, name, 'dir', '').id);
    }
    async move(id: string, parent: string, name: string) {
        this.gate('move');
        this.hub.rename(id, parent, name);
        return this.entry(id);
    }
    async upload(parent: string, name: string, p: string, _s: Source) {
        this.gate('upload');
        const content = readFileSync(path.join(this.root, p), 'utf8');
        this.afterRead();
        return this.entry(this.hub.add(parent, name, 'file', content).id);
    }
    async uploadRevision(id: string, p: string) {
        this.gate('uploadRevision');
        const content = readFileSync(path.join(this.root, p), 'utf8');
        this.afterRead();
        this.hub.edit(id, content);
        return this.entry(id);
    }
    async download(id: string, tmp: string) {
        this.gate('download');
        const content = this.hub.nodes.get(id)!.content;
        if (this.corruptDownloads > 0) {
            this.corruptDownloads--;
            writeFileSync(tmp, `corrupted ${content}`);
        } else writeFileSync(tmp, content);
    }
    async trash(id: string) {
        this.gate('trash');
        this.hub.trash(id);
    }
}

const dirs: string[] = [];

/** Removes every folder made by `machine`. Call it from afterEach. */
export function cleanWorlds() {
    for (const d of dirs.splice(0)) {
        rmSync(d, { recursive: true, force: true });
    }
}

export interface MachineOptions {
    caseInsensitive?: boolean;
    maxDeletes?: number;
    isFatal?: (e: unknown) => boolean;
    log?: (level: string, message: string) => void;
    home?: string;
}

export type Machine = ReturnType<typeof machine>;

export function machine(tag: string, hub: Hub, o: MachineOptions = {}) {
    const home = o.home ?? mkdtempSync(path.join(tmpdir(), `proton-sync-it-${tag}-`));
    if (!o.home) dirs.push(home);
    const root = path.join(home, 'Proton');
    mkdirSync(root, { recursive: true });
    createRootMarker(root);
    const quarantine = path.join(home, 'quarantine');
    const dbPath = path.join(home, 'state.sqlite');
    const store = new SqliteStore(dbPath);
    const local = new RealLocalFs(root, quarantine, { ignore: defaultIgnore });
    const drive = new FakeDrive(hub, root);
    let k = 0;
    const engineOptions = { deviceName: tag, caseInsensitive: o.caseInsensitive ?? false, maxDeletes: o.maxDeletes ?? 20, newKey: () => `${tag}${Date.now()}-${++k}`, today: () => '2026-11-05', isFatal: o.isFatal, log: o.log as never };
    const engine = new Engine(local, drive, store, engineOptions);
    return { tag, home, root, quarantine, dbPath, engine, store, drive, local, abs: (p: string) => path.join(root, p) };
}

export async function settle(...ms: Machine[]) {
    for (let i = 0; i < 16; i++) {
        let work = 0;
        for (const m of ms) {
            const r = await m.engine.cycle();
            if (r.errors.length) throw new Error(`errors on ${m.tag}: ${r.errors.join('; ')}`);
            work += r.plan.actions.length;
        }
        if (!work) return;
    }
    throw new Error('does not converge');
}

/** File contents by path. Empty folders are left out. */
export function tree(root: string, rel = ''): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
        if (e.name.startsWith('.proton-sync') || e.isSymbolicLink()) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) Object.assign(out, tree(root, p));
        else out[p] = readFileSync(path.join(root, p), 'utf8');
    }
    return out;
}

/** Same as `tree`, with folders shown as `<dir>`, to compare with `Hub.tree()`. NFC, as the Drive. */
export function fullTree(root: string, rel = ''): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
        if (e.name.startsWith('.proton-sync') || e.isSymbolicLink()) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
            out[p.normalize('NFC')] = '<dir>';
            Object.assign(out, fullTree(root, p));
        } else out[p.normalize('NFC')] = readFileSync(path.join(root, p), 'utf8');
    }
    return out;
}

export function allFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [readFileSync(path.join(dir, e.name), 'utf8')]));
}

/** Every version the sync saw must stay recoverable: locally, on the Drive, or in quarantine. */
export class Ledger {
    private seen = new Set<string>();
    saw(content: string) {
        this.seen.add(content);
    }
    missing(hub: Hub, ms: Machine[]): string[] {
        const everywhere = new Set<string>();
        for (const n of hub.nodes.values()) for (const c of n.revisions) everywhere.add(c);
        for (const m of ms) {
            for (const c of Object.values(tree(m.root))) everywhere.add(c);
            for (const c of allFiles(m.quarantine)) everywhere.add(c);
        }
        return [...this.seen].filter((c) => !everywhere.has(c));
    }
}

/** Two machines, one Drive and a user acting on any of them, with the no-loss ledger kept up to date. */
export function world(o: MachineOptions = {}) {
    const hub = new Hub();
    const a = machine('A', hub, o);
    const b = machine('B', hub, o);
    const ledger = new Ledger();
    const node = (rel: string) => {
        for (const n of hub.nodes.values()) {
            if (!hub.alive(n)) continue;
            const parts = [n.name];
            for (let p = n.parent; p !== ROOT; p = hub.nodes.get(p)!.parent) parts.unshift(hub.nodes.get(p)!.name);
            if (parts.join('/').normalize('NFC') === rel.normalize('NFC')) return n;
        }
        throw new Error(`not on the Drive: ${rel}`);
    };
    const parentId = (rel: string) => (rel.includes('/') ? node(rel.slice(0, rel.lastIndexOf('/'))).id : ROOT);
    const base = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
    const web = {
        node,
        mkdir: (rel: string) => hub.add(parentId(rel), base(rel), 'dir', ''),
        write(rel: string, content: string) {
            ledger.saw(content);
            let existing;
            try {
                existing = node(rel);
            } catch {
                return hub.add(parentId(rel), base(rel), 'file', content);
            }
            hub.edit(existing.id, content);
            return existing;
        },
        move: (from: string, to: string) => hub.rename(node(from).id, parentId(to), base(to)),
        trash: (rel: string) => hub.trash(node(rel).id),
        copy(from: string, to: string) {
            const n = node(from);
            if (n.kind === 'file') return hub.add(parentId(to), base(to), 'file', n.content);
            hub.add(parentId(to), base(to), 'dir', '');
            for (const c of hub.nodes.values()) if (c.parent === n.id && !c.trashed) web.copy(`${from}/${c.name}`, `${to}/${c.name}`);
        },
        restore(id: string) {
            hub.nodes.get(id)!.trashed = false;
        },
    };
    const write = (m: Machine, rel: string, content: string) => {
        mkdirSync(path.dirname(m.abs(rel)), { recursive: true });
        writeFileSync(m.abs(rel), content);
        ledger.saw(content);
    };
    return {
        hub,
        a,
        b,
        ledger,
        web,
        write,
        mkdir: (m: Machine, rel: string) => mkdirSync(m.abs(rel), { recursive: true }),
        move: (m: Machine, from: string, to: string) => {
            mkdirSync(path.dirname(m.abs(to)), { recursive: true });
            renameSync(m.abs(from), m.abs(to));
        },
        copy: (m: Machine, from: string, to: string) => cpSync(m.abs(from), m.abs(to), { recursive: true }),
        rm: (m: Machine, rel: string) => rmSync(m.abs(rel), { recursive: true }),
        exists: (m: Machine, rel: string) => {
            try {
                lstatSync(m.abs(rel));
                return true;
            } catch {
                return false;
            }
        },
        settle: (...ms: Machine[]) => settle(...(ms.length ? ms : [a, b])),
        /** The end state of every scenario: everything converged, nothing lost. */
        assertConverged() {
            const t = Object.fromEntries(Object.entries(hub.tree()).map(([k, v]) => [k.normalize('NFC'), v]));
            const ta = fullTree(a.root);
            const tb = fullTree(b.root);
            if (JSON.stringify(sorted(ta)) !== JSON.stringify(sorted(t))) throw new Error(`A differs from the Drive\nA: ${JSON.stringify(sorted(ta))}\nDrive: ${JSON.stringify(sorted(t))}`);
            if (JSON.stringify(sorted(tb)) !== JSON.stringify(sorted(t))) throw new Error(`B differs from the Drive\nB: ${JSON.stringify(sorted(tb))}\nDrive: ${JSON.stringify(sorted(t))}`);
            const lost = ledger.missing(hub, [a, b]);
            if (lost.length) throw new Error(`lost content: ${JSON.stringify(lost)}`);
        },
    };
}

const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
