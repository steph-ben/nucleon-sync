import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LEGACY_ROOT_MARKER, ROOT_MARKER } from '../src/names';
import { spawnSync } from 'node:child_process';
import { activeLegacyService, applyMigration, findLegacy, isDaemonRunning, legacyDaemonFor, planMigration, type MigrationIo } from '../src/migrate';

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

const stopped = () => false;
const plan = () => planMigration(legacy, fresh, stopped);

describe('review fixes', () => {
    test('1. no legacy marker in localRoot (unmounted disk) blocks, and apply re-checks', async () => {
        const ok = plan();
        fs.rmSync(path.join(synced, LEGACY_ROOT_MARKER));
        expect(planMigration(legacy, fresh, stopped).blocked).toContain(LEGACY_ROOT_MARKER);
        await expect(applyMigration(ok, io)).rejects.toThrow(LEGACY_ROOT_MARKER);
        expect(fs.existsSync(path.join(synced, ROOT_MARKER))).toBe(false);
        expect(fs.existsSync(fresh)).toBe(false);
        fs.rmSync(synced, { recursive: true });
        expect(planMigration(legacy, fresh, stopped).blocked).toContain(LEGACY_ROOT_MARKER);
    });

    test('2. a live daemon in ANY found legacy folder blocks, with the stop commands in the message', () => {
        const stale = path.join(home, '.local/share/proton-sync-stale');
        const blocked = planMigration(legacy, fresh, (d) => d === stale, { otherDirs: [legacy, stale], commands: ['systemctl --user stop X', 'systemctl --user disable X'] });
        expect(blocked.blocked).toContain('stop the old daemon');
        expect(blocked.blocked).toContain('systemctl --user stop X');
        expect(blocked.blocked).toContain('systemctl --user disable X');
    });

    test('2. an active or enabled legacy service blocks', () => {
        const withService = planMigration(legacy, fresh, stopped, { activeService: () => 'proton-sync.service is enabled' });
        expect(withService.blocked).toContain('is enabled');
    });

    test('2. activeLegacyService asks systemd, with injected commands', () => {
        fs.mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true });
        fs.writeFileSync(path.join(home, '.config/systemd/user/proton-sync.service'), '');
        const run = (active: number, enabled: string) => (c: string, a: string[]) =>
            a.includes('is-active') ? { status: active, stdout: '' } : { status: 0, stdout: enabled };
        expect(activeLegacyService(home, 1000, run(0, 'disabled'))).toContain('active');
        expect(activeLegacyService(home, 1000, run(3, 'enabled\n'))).toContain('enabled');
        expect(activeLegacyService(home, 1000, run(3, 'disabled\n'))).toBeUndefined();
    });

    test('2. the new daemon sees a live legacy daemon with the same localRoot only', () => {
        expect(legacyDaemonFor(home, synced, () => true)).toBe(legacy);
        expect(legacyDaemonFor(home, '/elsewhere', () => true)).toBeUndefined();
        expect(legacyDaemonFor(home, synced, () => false)).toBeUndefined();
    });

    test('3. recheck right before the first copy stops the migration, nothing written', async () => {
        await expect(applyMigration(plan(), { ...io, recheck: () => 'stop the old daemon first (it came back)' })).rejects.toThrow('came back');
        expect(fs.existsSync(path.join(fresh, 'config.json'))).toBe(false);
        expect(fs.existsSync(path.join(fresh, 'state.sqlite'))).toBe(false);
        expect(secrets.has('nucleon-sync/session|auth-session')).toBe(false);
    });

    test('4. a throwing readSecret writes nothing, and a rerun succeeds', async () => {
        const before = hashTree(legacy);
        const broken = { ...io, readSecret: async () => { throw new Error('keychain locked'); } };
        await expect(applyMigration(plan(), broken)).rejects.toThrow('keychain locked');
        expect(fs.existsSync(fresh)).toBe(false);
        await applyMigration(plan(), io);
        expect(fs.existsSync(path.join(fresh, 'config.json'))).toBe(true);
        expect(hashTree(legacy)).toEqual(before);
    });

    test('4. a throwing writeSecret leaves no database in place, a rerun resumes', async () => {
        const broken = { ...io, writeSecret: async () => { throw new Error('keychain write failed'); } };
        await expect(applyMigration(plan(), broken)).rejects.toThrow('keychain write failed');
        expect(fs.existsSync(path.join(fresh, 'state.sqlite'))).toBe(false);
        expect(plan().blocked).toBeUndefined();
        await applyMigration(plan(), io);
        expect(fs.readFileSync(path.join(fresh, 'state.sqlite'), 'utf8')).toBe('db');
        expect(fs.existsSync(path.join(fresh, '.migrating'))).toBe(false);
    });

    test('4. database files without config.json: blocked with the recovery steps', () => {
        fs.mkdirSync(fresh, { recursive: true });
        fs.writeFileSync(path.join(fresh, 'state.sqlite'), 'half');
        const blocked = plan().blocked!;
        expect(blocked).toContain('stopped half way');
        expect(blocked).toContain(`mv ${fresh}`);
    });

    test('5. a missing legacy secret is reported as a warning', async () => {
        secrets.clear();
        const warnings = await applyMigration(plan(), io);
        expect(warnings).toContain('no saved login: run nucleon-sync login');
        expect(secrets.size).toBe(0);
    });

    test('same folder, malformed config and config without localRoot are blocked with a reason', () => {
        expect(planMigration(legacy, legacy, stopped).blocked).toContain('is the old one');
        fs.writeFileSync(path.join(legacy, 'config.json'), '{nope');
        expect(plan().blocked).toContain('not valid JSON');
        fs.writeFileSync(path.join(legacy, 'config.json'), '{"remote":"root"}');
        expect(plan().blocked).toContain('no localRoot');
    });
});

describe('isDaemonRunning', () => {
    const lock = () => path.join(legacy, 'daemon.lock');
    test('live pid', () => {
        fs.writeFileSync(lock(), String(process.pid));
        expect(isDaemonRunning(legacy)).toBe(true);
    });
    test('stale pid (process already exited)', () => {
        fs.writeFileSync(lock(), String(spawnSync('true').pid));
        expect(isDaemonRunning(legacy)).toBe(false);
    });
    test('garbage pid or no lock', () => {
        fs.writeFileSync(lock(), 'not a pid');
        expect(isDaemonRunning(legacy)).toBe(false);
        fs.rmSync(lock());
        expect(isDaemonRunning(legacy)).toBe(false);
    });
});
