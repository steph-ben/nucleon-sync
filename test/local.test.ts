import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RealLocalFs, createRootMarker, defaultIgnore, detectCaseInsensitive, sha1File } from '../src/adapters/local';
import { SqliteStore } from '../src/adapters/sqlite-store';
import { PathBusy } from '../src/core/interfaces';
import { type BaseRec, ROOT } from '../src/core/types';

let tmp: string;
let root: string;
let quar: string;
let L: RealLocalFs;

const w = (rel: string, data = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
};
const names = async (l = L) => [...(await l.scan(new Map())).values()].map((e) => e.name).sort();

beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psync-test-'));
    root = path.join(tmp, 'root');
    quar = path.join(tmp, 'quarantine');
    fs.mkdirSync(root);
    await createRootMarker(root);
    L = new RealLocalFs(root, quar, { clock: () => '2026-11-05T10:00:00Z' });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('RealLocalFs', () => {
    test('assertRootSafe: marker missing, root missing', async () => {
        await L.assertRootSafe();
        fs.rmSync(path.join(root, '.proton-sync-root'));
        await expect(L.assertRootSafe()).rejects.toThrow();
        await expect(new RealLocalFs(path.join(tmp, 'nope'), quar).assertRootSafe()).rejects.toThrow();
    });

    test('stable id after rename, correct parents', async () => {
        w('d/a.txt', 'hello');
        const s1 = await L.scan(new Map());
        const a1 = [...s1.values()].find((e) => e.name === 'a.txt')!;
        const d1 = [...s1.values()].find((e) => e.name === 'd')!;
        expect(a1.parent).toBe(d1.id);
        expect(d1.parent).toBe(ROOT);
        expect(a1.hash).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
        await L.move('d', 'e');
        const s2 = await L.scan(new Map());
        expect(s2.get(d1.id)!.name).toBe('e');
        expect(s2.get(a1.id)!.parent).toBe(d1.id);
    });

    test('ignore rules, marker and tmp invisible, swap visible', async () => {
        for (const f of ['.DS_Store', '._x', '.nfs1', '.rclone-a', '~$doc', '.~lock.f#', 'a.swp', '.Trash-1000', '.proton-sync-swap-1', 'ok']) w(f);
        w('.venv/x');
        w('sub/__pycache__/y');
        fs.mkdirSync(path.join(root, '.proton-sync-tmp'));
        w('.proton-sync-tmp/z');
        expect(await names()).toEqual(['.proton-sync-swap-1', 'ok', 'sub']);
        expect(defaultIgnore('.venv', false)).toBe(false);
    });

    test('symlink not followed', async () => {
        w('real/f.txt');
        fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
        fs.symlinkSync(path.join(root, 'real/f.txt'), path.join(root, 'flink'));
        expect(await names()).toEqual(['f.txt', 'real']);
    });

    test('hard links: second id gets a suffix', async () => {
        w('a', 'same');
        fs.linkSync(path.join(root, 'a'), path.join(root, 'b'));
        const s = await L.scan(new Map());
        expect(s.size).toBe(2);
        expect([...s.keys()].filter((k) => k.includes('#')).length).toBe(1);
    });

    test('hash reused if size and mtime are identical', async () => {
        w('f', 'aaaa');
        const s1 = await L.scan(new Map());
        const e = [...s1.values()][0]!;
        const st = fs.statSync(path.join(root, 'f'));
        fs.writeFileSync(path.join(root, 'f'), 'bbbb');
        fs.utimesSync(path.join(root, 'f'), st.atime, st.mtime);
        const rec = { key: 'k', localId: e.id, size: e.size, localMtime: e.mtime, hash: 'FAKE-REUSED' } as BaseRec;
        const s2 = await L.scan(new Map([[e.id, rec]]));
        expect(s2.get(e.id)!.hash).toBe('FAKE-REUSED');
        const s3 = await L.scan(new Map([[e.id, { ...rec, size: 99 }]]));
        expect(s3.get(e.id)!.hash).toBe(await sha1File(path.join(root, 'f')));
    });

    test('move never replaces', async () => {
        w('a', 'A');
        w('b', 'B');
        await expect(L.move('a', 'b')).rejects.toBeInstanceOf(PathBusy);
        expect(fs.readFileSync(path.join(root, 'b'), 'utf8')).toBe('B');
        expect(fs.existsSync(path.join(root, 'a'))).toBe(true);
    });

    test('case-only rename', async () => {
        w('abc', 'A');
        if (!(await detectCaseInsensitive(root))) return; // not applicable on a case-sensitive FS
        await L.move('abc', 'ABC');
        expect(fs.readdirSync(root)).toContain('ABC');
        expect(fs.readdirSync(root)).not.toContain('abc');
    });

    test('quarantine keeps the content, without collisions', async () => {
        w('d/f.txt', 'precious');
        await L.quarantine('d/f.txt');
        expect(fs.existsSync(path.join(root, 'd/f.txt'))).toBe(false);
        w('d/f.txt', 'second');
        await L.quarantine('d/f.txt');
        const day = path.join(quar, '2026-11-05');
        const slots = fs.readdirSync(day);
        expect(slots.length).toBe(2);
        const contents = slots.map((s) => fs.readFileSync(path.join(day, s, 'd/f.txt'), 'utf8')).sort();
        expect(contents).toEqual(['precious', 'second']);
    });

    test('quarantine EXDEV: copy, verify, then removal', async () => {
        const l = new RealLocalFs(root, quar, {
            clock: () => '2026-11-05T10:00:00Z',
            rename: async (a, b) => {
                if (a.startsWith(root)) throw Object.assign(new Error('xdev'), { code: 'EXDEV' });
                fs.renameSync(a, b);
            },
        });
        w('d/f.txt', 'precious');
        await l.quarantine('d');
        expect(fs.existsSync(path.join(root, 'd'))).toBe(false);
        const day = path.join(quar, '2026-11-05');
        const slot = fs.readdirSync(day)[0]!;
        expect(fs.readFileSync(path.join(day, slot, 'd/f.txt'), 'utf8')).toBe('precious');
    });

    test('writeFile: success, mtime and hash', async () => {
        const e = await L.writeFile('n.txt', 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d', 1_700_000_000_000, async (t) => void fs.writeFileSync(t, 'hello'));
        expect(e.hash).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
        expect(e.mtime).toBe(1_700_000_000_000);
        expect(fs.readdirSync(path.join(root, '.proton-sync-tmp'))).toEqual([]);
    });

    test('writeFile: wrong hash, nothing left behind', async () => {
        await expect(L.writeFile('n.txt', 'deadbeef', 1000, async (t) => void fs.writeFileSync(t, 'hello'))).rejects.toThrow();
        expect(fs.existsSync(path.join(root, 'n.txt'))).toBe(false);
        expect(fs.readdirSync(path.join(root, '.proton-sync-tmp'))).toEqual([]);
    });

    test('writeFile refuses an existing destination', async () => {
        w('n.txt', 'old');
        await expect(L.writeFile('n.txt', undefined, 1000, async (t) => void fs.writeFileSync(t, 'new'))).rejects.toBeInstanceOf(PathBusy);
        expect(fs.readFileSync(path.join(root, 'n.txt'), 'utf8')).toBe('old');
        expect(fs.readdirSync(path.join(root, '.proton-sync-tmp'))).toEqual([]);
    });

    test('mkdir: EEXIST gives PathBusy', async () => {
        const e = await L.mkdir('x');
        expect(e.kind).toBe('dir');
        await expect(L.mkdir('x')).rejects.toBeInstanceOf(PathBusy);
    });

    test('path traversal refused', async () => {
        expect(() => L.absolutePath('../x')).toThrow();
        expect(() => L.absolutePath('a/../../x')).toThrow();
        expect(() => L.absolutePath('/etc/passwd')).toThrow();
        await expect(L.move('a', '../b')).rejects.toThrow();
        await expect(L.quarantine('../x')).rejects.toThrow();
        await expect(L.mkdir('../x')).rejects.toThrow();
    });

    test('isUnchanged', async () => {
        w('f', 'abc');
        w('d/g');
        const s = await L.scan(new Map());
        const f = [...s.values()].find((e) => e.name === 'f')!;
        const d = [...s.values()].find((e) => e.name === 'd')!;
        expect(await L.isUnchanged('f', f)).toBe(true);
        expect(await L.isUnchanged('d', d)).toBe(true);
        fs.appendFileSync(path.join(root, 'f'), 'more');
        expect(await L.isUnchanged('f', f)).toBe(false);
        expect(await L.isUnchanged('absent', f)).toBe(false);
    });

    test('vanished or unreadable file: ignored with a warning', async () => {
        w('ok', 'x');
        w('bad', 'x');
        fs.chmodSync(path.join(root, 'bad'), 0o000);
        const s = await L.scan(new Map());
        fs.chmodSync(path.join(root, 'bad'), 0o644);
        if (process.getuid?.() !== 0) {
            expect([...s.values()].map((e) => e.name)).toEqual(['ok']);
            expect(L.scanWarnings.length).toBe(1);
        }
    });
});

describe('SqliteStore', () => {
    const rec = (key: string, extra: Partial<BaseRec> = {}): BaseRec => ({ key, parent: ROOT, name: 'n', kind: 'file', localId: 'l', remoteId: 'r', size: 3, localMtime: 5, ...extra });

    test('round trip and persistence after reopening', () => {
        const file = path.join(tmp, 's.db');
        const s = new SqliteStore(file);
        s.put(rec('a', { hash: 'h', rev: 'v1' }));
        s.put(rec('b'));
        s.put(rec('a', { hash: 'h2' }));
        s.remove('b');
        s.setKv('cursor', '42');
        s.close();
        const s2 = new SqliteStore(file);
        expect(s2.all()).toEqual([rec('a', { hash: 'h2' })]);
        expect(s2.getKv('cursor')).toBe('42');
        expect(s2.getKv('none')).toBeUndefined();
        s2.close();
    });
});

test('a base from an earlier version opens, and keeps its records', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proton-sync-old-')), 'state.sqlite');
    const old = new Database(file);
    old.exec(`CREATE TABLE base (key TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        localId TEXT NOT NULL, remoteId TEXT NOT NULL, hash TEXT, size INTEGER NOT NULL, localMtime INTEGER NOT NULL, rev TEXT)`);
    old.exec(`INSERT INTO base VALUES ('k', '__root__', 'f', 'file', 'l', 'r', 'h', 1, 2, 'v')`);
    old.close();
    const store = new SqliteStore(file);
    expect(store.all()).toEqual([{ key: 'k', parent: '__root__', name: 'f', kind: 'file', localId: 'l', remoteId: 'r', hash: 'h', size: 1, localMtime: 2, rev: 'v' }]);
    store.put({ ...store.all()[0]!, localCtime: 3 });
    expect(store.all()[0]!.localCtime).toBe(3);
    store.close();
});
