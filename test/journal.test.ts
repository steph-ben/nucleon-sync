import { describe, expect, test } from 'bun:test';

import { Engine } from '../src/core/engine';
import { type LogLevel, ROOT } from '../src/core/types';
import { defaultIgnore } from '../src/adapters/local';
import { ChangeTracker } from '../src/watch';
import { Hub, MemStore, SimLocal, SimRemote } from './sim';

function device(tag: string, hub: Hub) {
    const lines: string[] = [];
    const touched: string[][] = [];
    const local = new SimLocal(tag);
    const remote = new SimRemote(hub, local);
    const store = new MemStore();
    let k = 0;
    const engine = new Engine(local, remote, store, {
        deviceName: tag,
        caseInsensitive: false,
        maxDeletes: 20,
        newKey: () => `${tag}k${++k}`,
        today: () => '2026-11-05',
        log: (level: LogLevel, msg: string) => void lines.push(`${level} ${msg}`),
        touched: (paths: string[]) => void touched.push(paths),
    });
    return { local, remote, store, engine, lines, touched };
}

async function settle(...devs: ReturnType<typeof device>[]) {
    for (let i = 0; i < 12; i++) {
        let work = 0;
        for (const d of devs) work += (await d.engine.cycle()).plan.actions.length;
        if (work === 0) return;
    }
    throw new Error('does not converge');
}

describe('action journal', () => {
    test('each transfer says its direction and its path', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const l = device('L', hub);
        const d = m.local.add(ROOT, 'Docs', 'dir', '');
        m.local.add(d.id, 'a.txt', 'file', 'A');
        await settle(m, l);
        expect(m.lines).toContain('INFO local→drive  mkdir  Docs');
        expect(m.lines).toContain('INFO local→drive  upload  Docs/a.txt');
        expect(l.lines).toContain('INFO drive→local  mkdir  Docs');
        expect(l.lines).toContain('INFO drive→local  download  Docs/a.txt');
    });

    test('a rename is logged as one move with old and new path', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const l = device('L', hub);
        const d = m.local.add(ROOT, 'Music', 'dir', '');
        m.local.add(d.id, 'f', 'file', 'x');
        await settle(m, l);
        m.lines.length = l.lines.length = 0;
        d.name = 'Musique';
        await settle(m, l);
        expect(m.lines).toContain('INFO local→drive  move  Music -> Musique');
        expect(l.lines).toContain('INFO drive→local  move  Music -> Musique');
        expect(l.lines.filter((x) => /download|upload/.test(x))).toEqual([]);
    });

    test('bookkeeping stays at debug level', async () => {
        const hub = new Hub();
        hub.add(ROOT, 'a.txt', 'file', 'A');
        const m = device('M', hub);
        m.local.add(ROOT, 'a.txt', 'file', 'A');
        await settle(m);
        expect(m.lines.filter((x) => x.startsWith('INFO'))).toEqual([]);
        expect(m.lines.some((x) => x.startsWith('DEBUG bookkeeping  link'))).toBe(true);
    });

    test('a failing action is logged as an error with its path and cause', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        m.remote.chaos = {
            before(op: string) {
                if (op.includes('upload')) throw new Error('network timeout');
            },
        };
        m.local.add(ROOT, 'big.zip', 'file', 'Z');
        const r = await m.engine.cycle();
        expect(r.errors.length).toBe(1);
        expect(m.lines).toContain('ERROR local→drive  upload  big.zip: network timeout');
    });

    test('paths written by the sync are reported before the write', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const l = device('L', hub);
        m.local.add(ROOT, 'x.txt', 'file', 'X');
        await settle(m, l);
        expect(m.touched).toEqual([]);
        expect(l.touched).toContainEqual(['x.txt']);
    });
});

describe('ChangeTracker', () => {
    const t = () => new ChangeTracker(defaultIgnore);

    test('ignored files never count as changes', () => {
        const c = t();
        for (const n of ['.DS_Store', 'a/.DS_Store', '.venv/lib/x', '.nucleon-sync-tmp/x', '.nucleon-sync-root', '.proton-sync-tmp/x', '.proton-sync-root', 'a/.nucleon-sync-swap-M-1']) expect(c.classify(n, 0)).toBe('ignored');
        expect(c.hasPending()).toBe(false);
    });

    test('a user change is local and pending until drained', () => {
        const c = t();
        expect(c.classify('hulll', 0)).toBe('local');
        expect(c.classify('hulll', 5)).toBe('local');
        expect(c.hasPending()).toBe(true);
        expect(c.drain()).toEqual(['hulll']);
        expect(c.hasPending()).toBe(false);
    });

    test('changes made by the daemon are recognised, with their parent folders', () => {
        const c = t();
        c.own(['hulll/coucou.txt'], 1000);
        expect(c.classify('hulll/coucou.txt', 1005)).toBe('own');
        expect(c.classify('hulll', 1005)).toBe('own');
        expect(c.hasPending()).toBe(false);
    });

    test('a daemon change expires: later user edits count', () => {
        const c = t();
        c.own(['a.txt'], 1000);
        expect(c.classify('a.txt', 5000)).toBe('local');
    });

    test('NFC and NFD spellings are the same path', () => {
        const c = t();
        c.own(['café.txt'.normalize('NFC')], 0);
        expect(c.classify('café.txt'.normalize('NFD'), 10)).toBe('own');
    });
});
