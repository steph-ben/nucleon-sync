import { describe, expect, test } from 'bun:test';

import { Engine } from '../src/core/engine';
import { ROOT } from '../src/core/types';
import { PathBusy } from '../src/core/interfaces';
import { Crash, Hub, MemStore, SimLocal, SimRemote } from './sim';

function device(tag: string, hub: Hub) {
    const local = new SimLocal(tag);
    const remote = new SimRemote(hub, local);
    const store = new MemStore();
    let k = 0;
    const engine = new Engine(local, remote, store, {
        deviceName: tag,
        caseInsensitive: false,
        maxDeletes: 20,
        newKey: () => `${tag}k${++k}`,
        isFatal: (e) => e instanceof Crash,
        today: () => '2026-11-05',
    });
    return { local, remote, store, engine };
}

async function settle(...devs: ReturnType<typeof device>[]) {
    for (let i = 0; i < 12; i++) {
        let work = 0;
        for (const d of devs) {
            const r = await d.engine.cycle();
            work += r.plan.actions.length;
        }
        if (work === 0) return;
    }
    throw new Error('does not converge');
}

describe('basic sync', () => {
    test('first run: no deletion, pairing by content', async () => {
        const hub = new Hub();
        hub.add(ROOT, 'a.txt', 'file', 'A');
        const m = device('M', hub);
        m.local.add(ROOT, 'a.txt', 'file', 'A');
        m.local.add(ROOT, 'b.txt', 'file', 'B');
        await settle(m);
        expect(hub.tree()).toEqual({ 'a.txt': 'A', 'b.txt': 'B' });
        expect(m.local.tree()).toEqual({ 'a.txt': 'A', 'b.txt': 'B' });
    });

    test('renaming a big folder = a single operation, zero transfer', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const l = device('L', hub);
        const d = m.local.add(ROOT, 'Music', 'dir', '');
        for (let i = 0; i < 300; i++) m.local.add(d.id, `f${i}`, 'file', `c${i}`);
        await settle(m, l);
        let moves = 0;
        let transfers = 0;
        for (const dev of [m, l]) {
            dev.remote.chaos = dev.local.chaos = {
                before(op) {
                    if (op.endsWith('.move')) moves++;
                    if (/upload|download|write/.test(op)) transfers++;
                },
            };
        }
        d.name = 'Musique';
        await settle(m, l);
        expect(moves).toBe(2); // Drive + other machine
        expect(transfers).toBe(0);
        expect(Object.keys(l.local.tree())).toContain('Musique/f299');
        expect(Object.keys(l.local.tree())).not.toContain('Music/f0');
    });
});

describe('conflicts: nothing is lost', () => {
    async function pair() {
        const hub = new Hub();
        const m = device('M', hub);
        m.local.add(ROOT, 'doc.txt', 'file', 'v1');
        await settle(m);
        return { hub, m, f: m.local.find('doc.txt')! };
    }

    test('modified on both sides: both versions kept', async () => {
        const { hub, m, f } = await pair();
        f.content = 'local';
        hub.edit([...hub.nodes.values()][0]!.id, 'remote');
        await settle(m);
        const t = hub.tree();
        expect(t['doc.txt']).toBe('remote');
        expect(t['doc (conflict M 2026-11-05).txt']).toBe('local');
        expect(m.local.tree()).toEqual(t);
    });

    test('deleted locally, modified on the Drive: the file comes back', async () => {
        const { hub, m, f } = await pair();
        m.local.nodes.delete(f.id);
        hub.edit([...hub.nodes.values()][0]!.id, 'v2');
        await settle(m);
        expect(m.local.tree()).toEqual({ 'doc.txt': 'v2' });
    });

    test('deleted on the Drive, modified locally: re-uploaded', async () => {
        const { hub, m, f } = await pair();
        f.content = 'v2';
        hub.trash([...hub.nodes.values()][0]!.id);
        await settle(m);
        expect(hub.tree()).toEqual({ 'doc.txt': 'v2' });
    });

    test('remote deletion: the local copy goes to quarantine', async () => {
        const { hub, m } = await pair();
        hub.trash([...hub.nodes.values()][0]!.id);
        await settle(m);
        expect(m.local.tree()).toEqual({});
        expect(m.local.quarantined).toEqual(['v1']);
    });

    test('folder deleted but content added on the other side: kept', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const d = m.local.add(ROOT, 'D', 'dir', '');
        m.local.add(d.id, 'x', 'file', 'X');
        await settle(m);
        const rd = [...hub.nodes.values()].find((n) => n.name === 'D')!;
        hub.trash(rd.id);
        m.local.add(d.id, 'new', 'file', 'N');
        await settle(m);
        expect(hub.tree()['D/new']).toBe('N');
        expect(m.local.tree()['D/new']).toBe('N');
    });
});

describe('safeguards', () => {
    test('Proton doc never touched: its folder is not moved to trash', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const rd = hub.add(ROOT, 'Reloger', 'dir', '');
        const doc = hub.add(rd.id, 'Meublingo', 'file', '', true);
        hub.add(rd.id, 'plan.pdf', 'file', 'P');
        await settle(m);
        expect(m.local.tree()).toEqual({ Reloger: '<dir>', 'Reloger/plan.pdf': 'P' });
        const ld = m.local.find('Reloger')!;
        m.local.nodes.delete(ld.id);
        m.local.nodes.delete(m.local.find('Reloger/plan.pdf')?.id ?? '');
        for (const n of m.local.nodes.values()) if (n.parent === ld.id) m.local.nodes.delete(n.id);
        await settle(m);
        expect(doc.trashed).toBe(false);
        expect(rd.trashed).toBe(false);
        expect(hub.alive(doc)).toBe(true);
    });

    test('large deletion: held until approval', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        for (let i = 0; i < 30; i++) m.local.add(ROOT, `f${i}`, 'file', `c${i}`);
        await settle(m);
        for (const n of [...m.local.nodes.values()]) m.local.nodes.delete(n.id);
        m.local.add(ROOT, 'remaining', 'file', 'r');
        const r = await m.engine.cycle();
        expect(r.plan.held.length).toBeGreaterThan(0);
        expect(Object.keys(hub.tree()).length).toBe(31);
        await m.engine.cycle(true);
        expect(Object.keys(hub.tree())).toEqual(['remaining']);
    });

    test('local folder emptied at once: stop', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        for (const n of ['a', 'b', 'c', 'd', 'e']) m.local.add(ROOT, n, 'file', n);
        await settle(m);
        m.local.nodes.clear();
        await expect(m.engine.cycle()).rejects.toThrow('empty');
        expect(Object.keys(hub.tree()).length).toBe(5);
    });

    test('missing root: stop', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        m.local.rootOk = false;
        await expect(m.engine.cycle()).rejects.toThrow('root');
    });
});

describe('crossed moves', () => {
    test('A into a new folder under B, and B into A: no cycle, nothing lost', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const a = m.local.add(ROOT, 'A', 'dir', '');
        const b = m.local.add(ROOT, 'B', 'dir', '');
        m.local.add(a.id, 'fa', 'file', 'FA');
        m.local.add(b.id, 'fb', 'file', 'FB');
        await settle(m);
        const n = m.local.add(b.id, 'N', 'dir', '');
        a.parent = n.id;
        const ra = [...hub.nodes.values()].find((x) => x.name === 'A')!;
        const rb = [...hub.nodes.values()].find((x) => x.name === 'B')!;
        hub.rename(rb.id, ra.id, 'B');
        await settle(m);
        const contents = Object.values(hub.tree());
        expect(contents).toContain('FA');
        expect(contents).toContain('FB');
        expect(m.local.tree()).toEqual(hub.tree());
    }, 5000);
});

describe('trash', () => {
    test('blocked move: the source folder does not go to trash with a Proton doc', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const rx = hub.add(ROOT, 'X', 'dir', '');
        const rr = hub.add(rx.id, 'Reloger', 'dir', '');
        const doc = hub.add(rr.id, 'Meublingo', 'file', '', true);
        await settle(m);
        const x = m.local.find('X')!;
        const r = m.local.find('X/Reloger')!;
        r.parent = ROOT;
        m.local.nodes.delete(x.id);
        let blocked = true;
        m.remote.chaos = {
            before(op) {
                if (op === 'remote.move' && blocked) throw new PathBusy('busy');
            },
        };
        await m.engine.cycle();
        expect(hub.alive(doc)).toBe(true);
        blocked = false;
        await settle(m);
        expect(hub.alive(doc)).toBe(true);
        expect(hub.tree()).toEqual({ Reloger: '<dir>' });
    });
});

describe('inversion', () => {
    test('a child folder becomes the parent of its former parent', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const rb = hub.add(ROOT, 'b', 'dir', '');
        const ra = hub.add(rb.id, 'a', 'dir', '');
        hub.add(ra.id, 'f', 'file', 'F');
        await settle(m);
        hub.rename(ra.id, ROOT, 'd');
        hub.rename(rb.id, ra.id, 'b');
        await settle(m);
        expect(m.local.tree()).toEqual(hub.tree());
        expect(hub.tree()['d/f']).toBe('F');
    });
});

describe('double move', () => {
    test('deleted locally, but an item moved on both sides stays in it: the folder is kept', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const rd = hub.add(ROOT, 'd', 'dir', '');
        const rf = hub.add(ROOT, 'a', 'file', 'F');
        await settle(m);
        m.local.find('a')!.name = 'b';
        const d = m.local.find('d')!;
        m.local.nodes.delete(d.id);
        hub.rename(rf.id, rd.id, 'Music');
        await settle(m);
        expect(rd.trashed).toBe(false);
        expect(m.local.tree()).toEqual(hub.tree());
        expect(hub.tree()['d/Music']).toBe('F');
    });
});

describe('resume and names', () => {
    test('file d filed into a new folder d', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const f = m.local.add(ROOT, 'd', 'file', 'F');
        await settle(m);
        const dir = m.local.add(ROOT, 'tmp', 'dir', '');
        f.parent = dir.id;
        f.name = 'Music';
        dir.name = 'd';
        await settle(m);
        expect(hub.tree()).toEqual({ d: '<dir>', 'd/Music': 'F' });
        expect(m.local.tree()).toEqual(hub.tree());
    });

    test('crash right after a rebind: the remote version is still received', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        m.local.add(ROOT, 'd', 'file', 'v1');
        await settle(m);
        const old = [...hub.nodes.values()][0]!;
        hub.trash(old.id);
        hub.add(ROOT, 'd', 'file', 'v2');
        m.local.chaos = {
            before() {
                throw new Crash('crash');
            },
        };
        await m.engine.cycle().catch(() => {});
        m.local.chaos = { before() {} };
        await settle(m);
        expect(m.local.tree()).toEqual({ d: 'v2' });
    });
});

describe('name swap', () => {
    test('two items swap names on one side and not the other: no loop', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const ra = hub.add(ROOT, 'x', 'file', 'A');
        const rb = hub.add(ROOT, 'y', 'file', 'B');
        await settle(m);
        const lb = m.local.find('y')!;
        lb.name = 'z';
        hub.rename(ra.id, ROOT, 'z');
        await settle(m);
        expect(m.local.tree()).toEqual(hub.tree());
        expect(Object.values(hub.tree()).sort()).toEqual(['A', 'B']);
        void rb;
    });
});

describe('unstable connection', () => {
    test('interrupted download: the old version stays in place', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        m.local.add(ROOT, 'doc', 'file', 'v1');
        await settle(m);
        hub.edit([...hub.nodes.values()][0]!.id, 'v2');
        m.remote.chaos = {
            before(op) {
                if (op === 'remote.download') throw new Crash('network down');
            },
        };
        await m.engine.cycle().catch(() => {});
        expect(m.local.tree()).toEqual({ doc: 'v1' });
        expect(m.local.quarantined).toEqual([]);
        m.remote.chaos = { before() {} };
        await settle(m);
        expect(m.local.tree()).toEqual({ doc: 'v2' });
        expect(m.local.quarantined).toEqual(['v1']);
    });
});

describe('inversion with name swap', () => {
    test("the child takes the parent's name, and the parent goes inside it under the child's name", async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const ra = hub.add(ROOT, 'a', 'dir', '');
        const rc = hub.add(ra.id, 'c', 'dir', '');
        hub.add(rc.id, 'f', 'file', 'F');
        await settle(m);
        hub.rename(ra.id, ROOT, 'tmp');
        hub.rename(rc.id, ROOT, 'a');
        hub.rename(ra.id, rc.id, 'c');
        await settle(m);
        expect(m.local.tree()).toEqual(hub.tree());
        expect(hub.tree()['a/f']).toBe('F');
    });
});
