import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SqliteStore } from '../src/adapters/sqlite-store';
import { assertSameTarget, Engine, SafetyStop } from '../src/core/engine';
import { moveStateAside, orphanDatabaseProblem } from '../src/desktop/setup';
import { Hub } from './sim';
import { cleanWorlds, FakeDrive, machine, settle, tree } from './lib/world';

afterEach(cleanWorlds);

const main = process.env.NUCLEON_ENTRY ?? path.join(import.meta.dir, '../src/main.ts');

/** A data folder inside a throwaway home. */
function dataFolder() {
    const data = path.join(mkdtempSync(path.join(tmpdir(), 'target-')), 'data');
    mkdirSync(data);
    return data;
}

function cli(data: string, args: string[], stdin = '') {
    const home = path.dirname(data);
    const r = Bun.spawnSync([process.execPath, main, ...args], {
        env: { PATH: process.env.PATH ?? '', HOME: home, NUCLEON_SYNC_HOME: data, PROTON_DRIVE_CREDENTIALS_STORE: 'unsafe_file' },
        cwd: data,
        stdin: Buffer.from(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function storeWithTarget(data: string, target: string) {
    const store = new SqliteStore(path.join(data, 'state.sqlite'));
    assertSameTarget(store, target);
    store.close();
}

describe('the database belongs to one target', () => {
    test('without the check, a new target with the old database would quarantine every local file', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        writeFileSync(path.join(a.root, 'one.txt'), '1');
        writeFileSync(path.join(a.root, 'two.txt'), '2');
        await settle(a);
        const engine = new Engine(a.local, new FakeDrive(new Hub(), a.root), a.store, { deviceName: 'A', caseInsensitive: false, maxDeletes: 20, newKey: () => 'n', today: () => '2026-11-05', emptyGuardMin: 99 });
        const plan = await engine.planOnly();
        expect(plan.actions.concat(plan.held).filter((x) => x.t === 'localQuarantine')).toHaveLength(2);
    });

    test('the same simulated case stops before any plan: 0 actions, every file in place', async () => {
        const hub = new Hub();
        const a = machine('A', hub);
        writeFileSync(path.join(a.root, 'one.txt'), '1');
        writeFileSync(path.join(a.root, 'two.txt'), '2');
        assertSameTarget(a.store, 'device:test/sandbox');
        await settle(a);
        const newDrive = new Hub();
        const engine = new Engine(a.local, new FakeDrive(newDrive, a.root), a.store, { deviceName: 'A', caseInsensitive: false, maxDeletes: 20, newKey: () => 'n', today: () => '2026-11-05', emptyGuardMin: 99 });
        let actions = 0;
        const pass = async () => {
            assertSameTarget(a.store, 'root');
            actions = (await engine.planOnly()).actions.length;
        };
        await expect(pass()).rejects.toBeInstanceOf(SafetyStop);
        expect(actions).toBe(0);
        expect(tree(a.root)).toEqual({ 'one.txt': '1', 'two.txt': '2' });
        expect(existsSync(a.quarantine)).toBe(false);
        expect(newDrive.nodes.size).toBe(0);
    });

    test('the target is stored at first use, the same one passes, and an old database adopts its config', () => {
        const data = dataFolder();
        const store = new SqliteStore(path.join(data, 'state.sqlite'));
        expect(store.getKv('target')).toBeUndefined();
        assertSameTarget(store, 'root');
        expect(store.getKv('target')).toBe('root');
        expect(() => assertSameTarget(store, 'root')).not.toThrow();
        expect(() => assertSameTarget(store, 'device:a/b')).toThrow('setup --reset');
        store.close();
    });

    test('plan stops with a safety error, offline and before any sign-in, and leaves the database alone', () => {
        const data = dataFolder();
        const folder = path.join(data, 'folder');
        mkdirSync(folder);
        storeWithTarget(data, 'device:test/sandbox');
        writeFileSync(path.join(data, 'config.json'), JSON.stringify({ localRoot: folder, remote: 'root', allowDriveRoot: true, deviceName: 'x', maxDeletes: 20 }));
        const r = cli(data, ['plan']);
        expect(r.code).toBe(1);
        expect(r.err).toContain('device:test/sandbox');
        expect(r.err).toContain('setup --reset');
        const store = new SqliteStore(path.join(data, 'state.sqlite'));
        expect(store.getKv('target')).toBe('device:test/sandbox');
        store.close();
    });

    test('run stops the same way, and the reason is in the log', () => {
        const data = dataFolder();
        const folder = path.join(data, 'folder');
        mkdirSync(folder);
        storeWithTarget(data, 'device:test/sandbox');
        writeFileSync(path.join(data, 'config.json'), JSON.stringify({ localRoot: folder, remote: 'root', allowDriveRoot: true, deviceName: 'x', maxDeletes: 20 }));
        const r = cli(data, ['run']);
        expect(r.code).toBe(1);
        expect(readFileSync(path.join(data, 'nucleon-sync.log'), 'utf8')).toContain('setup --reset');
    });
});

describe('setup without a config', () => {
    test('a database with no config is a clear problem', () => {
        const data = dataFolder();
        expect(orphanDatabaseProblem(data, path.join(data, 'config.json'))).toBeUndefined();
        writeFileSync(path.join(data, 'state.sqlite'), 'db');
        expect(orphanDatabaseProblem(data, path.join(data, 'config.json'))).toContain('setup --reset');
        writeFileSync(path.join(data, 'config.json'), '{}');
        expect(orphanDatabaseProblem(data, path.join(data, 'config.json'))).toBeUndefined();
    });

    test('setup refuses, and deletes nothing', () => {
        const data = dataFolder();
        writeFileSync(path.join(data, 'state.sqlite'), 'db');
        const r = cli(data, ['setup']);
        expect(r.code).toBe(1);
        expect(r.err).toContain('setup --reset');
        expect(readFileSync(path.join(data, 'state.sqlite'), 'utf8')).toBe('db');
    });
});

describe('setup --reset', () => {
    function filled() {
        const data = dataFolder();
        for (const name of ['config.json', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'nucleon-sync.log']) writeFileSync(path.join(data, name), name);
        mkdirSync(path.join(data, 'quarantine'));
        writeFileSync(path.join(data, 'quarantine/kept.txt'), 'kept');
        return data;
    }

    test('moves the config and the database aside, and only them', () => {
        const data = filled();
        const aside = moveStateAside(data, path.join(data, 'config.json'), new Date('2026-11-06T07:30:00Z'))!;
        expect(aside).toBe(path.join(data, 'reset-2026-11-06T07-30-00'));
        expect(readdirSync(aside).sort()).toEqual(['config.json', 'state.sqlite', 'state.sqlite-shm', 'state.sqlite-wal']);
        expect(readFileSync(path.join(aside, 'state.sqlite'), 'utf8')).toBe('state.sqlite');
        expect(existsSync(path.join(data, 'state.sqlite'))).toBe(false);
        expect(existsSync(path.join(data, 'config.json'))).toBe(false);
        expect(readFileSync(path.join(data, 'quarantine/kept.txt'), 'utf8')).toBe('kept');
        expect(existsSync(path.join(data, 'nucleon-sync.log'))).toBe(true);
    });

    test('a config outside the data folder is moved too, missing files are skipped', () => {
        const data = dataFolder();
        const config = path.join(path.dirname(data), `${path.basename(data)}.json`);
        writeFileSync(config, '{}');
        writeFileSync(path.join(data, 'state.sqlite'), 'db');
        const aside = moveStateAside(data, config, new Date('2026-11-06T07:30:00Z'))!;
        expect(readdirSync(aside).sort()).toEqual(['config.json', 'state.sqlite']);
    });

    test('with nothing to move it creates no folder', () => {
        const data = dataFolder();
        expect(moveStateAside(data, path.join(data, 'config.json'), new Date())).toBeUndefined();
        expect(readdirSync(data)).toEqual([]);
    });

    test('two resets in the same second keep both', () => {
        const data = filled();
        const now = new Date('2026-11-06T07:30:00Z');
        const first = moveStateAside(data, path.join(data, 'config.json'), now);
        writeFileSync(path.join(data, 'state.sqlite'), 'again');
        const second = moveStateAside(data, path.join(data, 'config.json'), now);
        expect(second).not.toBe(first);
        expect(readFileSync(path.join(second!, 'state.sqlite'), 'utf8')).toBe('again');
    });

    test('setup --reset moves the files, then runs setup normally', () => {
        const data = filled();
        const r = cli(data, ['setup', '--reset']);
        expect(r.out).toContain('Moved aside');
        expect(existsSync(path.join(data, 'state.sqlite'))).toBe(false);
        // The closed input answers no to the folder question: setup itself ran, and stopped there.
        expect(r.err).toContain('No answer, nothing was done');
    });

    test('setup --reset refuses while the daemon runs', () => {
        const data = filled();
        writeFileSync(path.join(data, 'daemon.lock'), String(process.pid));
        const r = cli(data, ['setup', '--reset']);
        expect(r.code).toBe(1);
        expect(r.err).toContain('running');
        expect(existsSync(path.join(data, 'state.sqlite'))).toBe(true);
    });
});
