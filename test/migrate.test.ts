import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LEGACY_ROOT_MARKER, ROOT_MARKER } from '../src/names';
import { applyMigration, findLegacy, planMigration, type MigrationIo } from '../src/migrate';

let home: string;
let legacy: string;
let fresh: string;
let synced: string;
let secrets: Map<string, string>;
let io: MigrationIo;

function hashTree(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else out[path.relative(dir, p)] = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        }
    };
    walk(dir);
    return out;
}

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
    legacy = path.join(home, '.local/share/proton-sync-main');
    fresh = path.join(home, '.local/share/nucleon-sync');
    synced = path.join(home, 'Proton');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(synced);
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ localRoot: synced, remote: 'root' }));
    fs.writeFileSync(path.join(legacy, 'state.sqlite'), 'db');
    fs.writeFileSync(path.join(legacy, 'state.sqlite-wal'), 'wal');
    fs.writeFileSync(path.join(legacy, 'state.sqlite-shm'), 'shm');
    fs.writeFileSync(path.join(synced, LEGACY_ROOT_MARKER), 'proton-sync\n');
    secrets = new Map([['proton-sync/session|auth-session', 'TOKEN']]);
    io = {
        readSecret: async (service, name) => secrets.get(`${service}|${name}`) ?? null,
        writeSecret: async (service, name, value) => void secrets.set(`${service}|${name}`, value),
    };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('findLegacy', () => {
    test('finds any proton-sync* folder holding a config.json, and the legacy unit', () => {
        fs.mkdirSync(path.join(home, '.local/share/proton-sync-empty'));
        fs.mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true });
        fs.writeFileSync(path.join(home, '.config/systemd/user/proton-sync.service'), '');
        const found = findLegacy(home);
        expect(found.dataDirs).toEqual([legacy]);
        expect(found.services).toEqual(['proton-sync.service']);
    });
});

describe('planMigration', () => {
    test('a running legacy daemon blocks the migration with a clear reason', () => {
        expect(planMigration(legacy, fresh, () => true).blocked).toContain('stop the old daemon');
    });

    test('a stopped daemon gives steps and no block', () => {
        const plan = planMigration(legacy, fresh, () => false);
        expect(plan.blocked).toBeUndefined();
        expect(plan.steps.length).toBeGreaterThan(0);
    });
});

describe('applyMigration', () => {
    test('nothing in the legacy folder or the synced folder is removed or changed', async () => {
        const before = hashTree(legacy);
        const syncedBefore = hashTree(synced);
        await applyMigration(planMigration(legacy, fresh, () => false), io);
        expect(hashTree(legacy)).toEqual(before);
        const after = hashTree(synced);
        for (const [file, hash] of Object.entries(syncedBefore)) expect(after[file]).toBe(hash);
        expect(secrets.get('proton-sync/session|auth-session')).toBe('TOKEN');
    });

    test('the new data folder gets config, database and session', async () => {
        await applyMigration(planMigration(legacy, fresh, () => false), io);
        expect(fs.readFileSync(path.join(fresh, 'config.json'), 'utf8')).toBe(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8'));
        expect(fs.readFileSync(path.join(fresh, 'state.sqlite'), 'utf8')).toBe('db');
        expect(fs.readFileSync(path.join(fresh, 'state.sqlite-wal'), 'utf8')).toBe('wal');
        expect(fs.readFileSync(path.join(fresh, 'state.sqlite-shm'), 'utf8')).toBe('shm');
        expect(secrets.get('nucleon-sync/session|auth-session')).toBe('TOKEN');
    });

    test('an existing new data folder is never overwritten', async () => {
        fs.mkdirSync(fresh, { recursive: true });
        fs.writeFileSync(path.join(fresh, 'config.json'), 'MINE');
        const plan = planMigration(legacy, fresh, () => false);
        expect(plan.blocked).toContain('already exists');
        await expect(applyMigration(plan, io)).rejects.toThrow('already exists');
        expect(fs.readFileSync(path.join(fresh, 'config.json'), 'utf8')).toBe('MINE');
        expect(secrets.has('nucleon-sync/session|auth-session')).toBe(false);
    });

    test('an existing new secret is never overwritten', async () => {
        secrets.set('nucleon-sync/session|auth-session', 'OTHER');
        await applyMigration(planMigration(legacy, fresh, () => false), io);
        expect(secrets.get('nucleon-sync/session|auth-session')).toBe('OTHER');
    });

    test('the legacy marker stays and the new one is added', async () => {
        await applyMigration(planMigration(legacy, fresh, () => false), io);
        expect(fs.existsSync(path.join(synced, LEGACY_ROOT_MARKER))).toBe(true);
        expect(fs.existsSync(path.join(synced, ROOT_MARKER))).toBe(true);
    });

    test('the second run does nothing', async () => {
        await applyMigration(planMigration(legacy, fresh, () => false), io);
        const before = hashTree(fresh);
        const second = planMigration(legacy, fresh, () => false);
        expect(second.blocked).toBeUndefined();
        expect(second.steps).toEqual([]);
        await applyMigration(second, io);
        expect(hashTree(fresh)).toEqual(before);
    });
});
