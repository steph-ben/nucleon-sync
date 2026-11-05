import { type LocalFs, PathBusy, type RemoteFs, type Source, type Store } from '../src/core/interfaces';
import { type BaseRec, type Entry, type Kind, ROOT, type Snapshot } from '../src/core/types';

export class Crash extends Error {}

export interface Chaos {
    /** Called before each adapter operation: may throw Crash or simulate the user. */
    before(op: string): void;
}
export const noChaos: Chaos = { before() {} };

interface Node {
    id: string;
    parent: string;
    name: string;
    kind: Kind;
    content: string;
    mtime: number;
}

const nfc = (s: string) => s.normalize('NFC');

export class MemStore implements Store {
    recs = new Map<string, BaseRec>();
    all() {
        return [...this.recs.values()].map((r) => ({ ...r }));
    }
    put(r: BaseRec) {
        this.recs.set(r.key, { ...r });
    }
    remove(k: string) {
        this.recs.delete(k);
    }
}

export class SimLocal implements LocalFs {
    nodes = new Map<string, Node>();
    quarantined: string[] = [];
    tmp = new Map<string, string>();
    rootOk = true;
    private seq = 0;
    chaos: Chaos = noChaos;
    clock = 1;

    constructor(readonly tag: string) {}

    private child(parent: string, name: string) {
        for (const n of this.nodes.values()) if (n.parent === parent && nfc(n.name) === nfc(name)) return n;
        return undefined;
    }
    find(path: string): Node | undefined {
        if (path === '') return undefined;
        let parent = ROOT;
        let n: Node | undefined;
        for (const p of path.split('/')) {
            n = this.child(parent, p);
            if (!n) return undefined;
            parent = n.id;
        }
        return n;
    }
    private parentOf(path: string): { parent: string; name: string } {
        const i = path.lastIndexOf('/');
        if (i < 0) return { parent: ROOT, name: path };
        const p = this.find(path.slice(0, i));
        if (!p || p.kind !== 'dir') throw new Error(`no parent ${path}`);
        return { parent: p.id, name: path.slice(i + 1) };
    }
    private entry(n: Node): Entry {
        return { id: n.id, parent: n.parent, name: n.name, kind: n.kind, size: n.content.length, mtime: n.mtime, hash: n.kind === 'file' ? n.content : undefined };
    }
    add(parent: string, name: string, kind: Kind, content: string): Node {
        const n = { id: `${this.tag}${++this.seq}`, parent, name, kind, content, mtime: ++this.clock };
        this.nodes.set(n.id, n);
        return n;
    }
    pathOf(n: Node): string {
        const parts = [n.name];
        for (let p = n.parent; p !== ROOT; p = this.nodes.get(p)!.parent) parts.unshift(this.nodes.get(p)!.name);
        return parts.join('/');
    }
    subtree(id: string): Node[] {
        const out = [this.nodes.get(id)!];
        for (const n of this.nodes.values()) if (n.parent === id) out.push(...this.subtree(n.id));
        return out;
    }
    tree(): Record<string, string> {
        const t: Record<string, string> = {};
        for (const n of this.nodes.values()) t[this.pathOf(n)] = n.kind === 'dir' ? '<dir>' : n.content;
        return t;
    }

    async assertRootSafe() {
        if (!this.rootOk) throw new Error('root missing');
    }
    async scan(): Promise<Snapshot> {
        return new Map([...this.nodes.values()].map((n) => [n.id, this.entry(n)]));
    }
    async mkdir(path: string) {
        this.chaos.before('local.mkdir');
        if (this.find(path)) throw new PathBusy(`already exists ${path}`);
        const { parent, name } = this.parentOf(path);
        return this.entry(this.add(parent, name, 'dir', ''));
    }
    async move(from: string, to: string) {
        this.chaos.before('local.move');
        const n = this.find(from);
        if (!n) throw new Error(`missing ${from}`);
        const existing = this.find(to);
        if (existing && existing !== n) throw new PathBusy(`destination busy ${to}`);
        const { parent, name } = this.parentOf(to);
        // Like a real file system: a folder cannot go into itself.
        if (this.subtree(n.id).some((x) => x.id === parent)) throw new Error(`move into itself ${from}`);
        n.parent = parent;
        n.name = name;
    }
    async isUnchanged(path: string, e: Entry) {
        const n = this.find(path);
        return !!n && n.id === e.id && (n.kind === 'dir' || n.content === e.hash);
    }
    async quarantine(path: string) {
        this.chaos.before('local.quarantine');
        const n = this.find(path);
        if (!n) throw new Error(`missing ${path}`);
        for (const c of this.subtree(n.id)) {
            if (c.kind === 'file') this.quarantined.push(c.content);
            this.nodes.delete(c.id);
        }
    }
    async openSource(path: string): Promise<Source> {
        const n = this.find(path);
        if (!n) throw new Error(`missing ${path}`);
        return { size: n.content.length, mtime: n.mtime };
    }
    async writeFile(path: string, expected: string | undefined, _mtime: number, fill: (tmp: string) => Promise<void>, beforeInstall?: () => Promise<void>) {
        const tmp = `tmp${++this.seq}`;
        await fill(tmp);
        const content = this.tmp.get(tmp)!;
        this.tmp.delete(tmp);
        if (expected !== undefined && content !== expected) throw new Error('invalid hash');
        await beforeInstall?.();
        this.chaos.before('local.write');
        if (this.find(path)) throw new PathBusy(`destination busy ${path}`);
        const { parent, name } = this.parentOf(path);
        return this.entry(this.add(parent, name, 'file', content));
    }
}

interface HubNode extends Node {
    rev: number;
    trashed: boolean;
    protected: boolean;
    revisions: string[];
}

export class Hub {
    nodes = new Map<string, HubNode>();
    private seq = 0;

    add(parent: string, name: string, kind: Kind, content: string, prot = false): HubNode {
        const n: HubNode = { id: `r${++this.seq}`, parent, name, kind, content, mtime: this.seq, rev: 1, trashed: false, protected: prot, revisions: [content] };
        if (this.taken(parent, name)) throw new PathBusy(`name taken ${name}`);
        this.nodes.set(n.id, n);
        return n;
    }
    taken(parent: string, name: string, self?: string) {
        for (const n of this.nodes.values()) if (n.id !== self && n.parent === parent && !n.trashed && nfc(n.name) === nfc(name)) return true;
        return false;
    }
    alive(n: HubNode): boolean {
        for (let c: HubNode | undefined = n; c; c = this.nodes.get(c.parent)) if (c.trashed) return false;
        return true;
    }
    edit(id: string, content: string) {
        const n = this.nodes.get(id)!;
        n.content = content;
        n.rev++;
        n.revisions.push(content);
    }
    rename(id: string, parent: string, name: string) {
        if (this.taken(parent, name, id)) throw new PathBusy(`name taken ${name}`);
        const n = this.nodes.get(id)!;
        n.parent = parent;
        n.name = name;
    }
    trash(id: string) {
        this.nodes.get(id)!.trashed = true;
    }
    tree(): Record<string, string> {
        const t: Record<string, string> = {};
        for (const n of this.nodes.values()) {
            if (!this.alive(n) || n.protected) continue;
            const parts = [n.name];
            for (let p = n.parent; p !== ROOT; p = this.nodes.get(p)!.parent) parts.unshift(this.nodes.get(p)!.name);
            t[parts.join('/')] = n.kind === 'dir' ? '<dir>' : n.content;
        }
        return t;
    }
    entry(n: HubNode): Entry {
        return { id: n.id, parent: n.parent, name: n.name, kind: n.kind, size: n.content.length, mtime: n.mtime, hash: n.kind === 'file' ? n.content : undefined, rev: String(n.rev), protected: n.protected };
    }
}

/** A device's view of the Drive: same constraints as the real one (unique names). */
export class SimRemote implements RemoteFs {
    chaos: Chaos = noChaos;
    constructor(
        private hub: Hub,
        private local: SimLocal,
    ) {}
    async snapshot() {
        const m: Snapshot = new Map();
        for (const n of this.hub.nodes.values()) if (this.hub.alive(n)) m.set(n.id, this.hub.entry(n));
        return m;
    }
    private live(id: string) {
        if (id === ROOT) return;
        const n = this.hub.nodes.get(id);
        if (!n || !this.hub.alive(n)) throw new Error(`node missing ${id}`);
    }
    async mkdir(parent: string, name: string) {
        this.chaos.before('remote.mkdir');
        this.live(parent);
        return this.hub.entry(this.hub.add(parent, name, 'dir', ''));
    }
    async move(id: string, parent: string, name: string) {
        this.chaos.before('remote.move');
        this.live(id);
        this.live(parent);
        for (let p = parent; p !== ROOT; p = this.hub.nodes.get(p)!.parent) if (p === id) throw new Error('move into itself');
        this.hub.rename(id, parent, name);
        return this.hub.entry(this.hub.nodes.get(id)!);
    }
    private read(path: string, expected: string | undefined) {
        const n = this.local.find(path);
        if (!n) throw new Error(`missing ${path}`);
        if (expected !== undefined && n.content !== expected) throw new Error('file modified during upload');
        return n.content;
    }
    async upload(parent: string, name: string, path: string, _s: Source, expected: string | undefined) {
        this.chaos.before('remote.upload');
        this.live(parent);
        return this.hub.entry(this.hub.add(parent, name, 'file', this.read(path, expected)));
    }
    async uploadRevision(id: string, path: string, _s: Source, expected: string | undefined) {
        this.chaos.before('remote.uploadRevision');
        this.live(id);
        this.hub.edit(id, this.read(path, expected));
        return this.hub.entry(this.hub.nodes.get(id)!);
    }
    async download(id: string, tmp: string) {
        this.chaos.before('remote.download');
        this.live(id);
        this.local.tmp.set(tmp, this.hub.nodes.get(id)!.content);
    }
    async trash(id: string) {
        this.chaos.before('remote.trash');
        this.live(id);
        this.hub.trash(id);
    }
}
