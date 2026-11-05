import { describe, expect } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { row } from '../lib/catalog';
import { loadHub, saveHub } from '../lib/hub-file';
import { machine, settle, tree, world } from '../lib/world';
import { Hub } from '../sim';

const area = 'Machine life';
const child = path.join(import.meta.dir, '../lib/sync-child.ts');
const main = path.join(import.meta.dir, '../../src/main.ts');
const ROOT_HINT = 'Proton';

async function seeded() {
    const w = world();
    for (const f of ['Albums/a.jpg', 'Albums/b.jpg', 'Albums/c.jpg', 'Notes/n.md', 'Notes/m.md', 'z.txt']) w.write(w.a, f, `contenu ${f}`);
    await w.settle();
    return w;
}
const trashed = (w: ReturnType<typeof world>) => [...w.hub.nodes.values()].filter((n) => n.trashed).length;

describe('machine life', () => {
    row({ id: 'machine.disk-full', area, gesture: 'The disk is full during a download', expected: 'The old version stays, nothing is deleted in that pass, it resumes after' }, async () => {
        const w = await seeded();
        w.web.write('z.txt', 'version 2');
        w.web.trash('Notes/n.md');
        w.a.drive.fail('download', () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
        const r = await w.a.engine.cycle();
        expect(r.errors.join()).toContain('no space');
        expect(readFileSync(w.a.abs('z.txt'), 'utf8')).toBe('contenu z.txt');
        expect(w.exists(w.a, 'Notes/n.md')).toBe(true);
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'machine.read-only-file', area, gesture: 'A read-only file is edited on the Drive', expected: 'The new version arrives, the old one is in quarantine' }, async () => {
        const w = await seeded();
        chmodSync(w.a.abs('z.txt'), 0o444);
        w.web.write('z.txt', 'version 2');
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'machine.read-only-folder', area, gesture: 'Something arrives in a read-only folder', expected: 'Reported, the file stays on the Drive, the rest continues, and it lands once writable' }, async () => {
        const w = await seeded();
        chmodSync(w.a.abs('Notes'), 0o555);
        w.web.write('Notes/nouveau.md', 'nouveau');
        w.web.write('ailleurs.md', 'ailleurs');
        const r = await w.a.engine.cycle();
        chmodSync(w.a.abs('Notes'), 0o755);
        expect(r.errors.length).toBeGreaterThan(0);
        expect(w.exists(w.a, 'ailleurs.md')).toBe(true);
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'machine.unreadable-folder', area, gesture: 'A folder becomes unreadable', expected: 'Nothing is deleted anywhere, with a warning' }, async () => {
        const w = await seeded();
        chmodSync(w.a.abs('Albums'), 0);
        try {
            const r = await w.a.engine.cycle();
            expect(r.plan.warnings.join()).toContain('Albums');
            expect(trashed(w)).toBe(0);
        } finally {
            chmodSync(w.a.abs('Albums'), 0o755);
        }
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'machine.root-vanishes-mid-scan', area, gesture: 'The synced folder disappears during a scan (disk unmounted)', expected: 'Nothing is deleted on the Drive or on the other machine' }, async () => {
        const hub = new Hub();
        let armed = false;
        let seen = 0;
        const a = machine('A', hub, {
            ignore: (name) => {
                if (armed && ++seen === 2) {
                    armed = false;
                    renameSync(a.root, `${a.root}-away`);
                }
                return name === '.DS_Store';
            },
        });
        for (const f of ['Albums/a.jpg', 'Albums/b.jpg', 'Notes/n.md', 'Notes/m.md', 'z.txt']) {
            mkdirSync(path.dirname(a.abs(f)), { recursive: true });
            writeFileSync(a.abs(f), f);
        }
        await settle(a);
        armed = true;
        await a.engine.cycle().catch(() => {});
        expect([...hub.nodes.values()].filter((n) => n.trashed)).toEqual([]);
        renameSync(`${a.root}-away`, a.root);
        await settle(a);
        expect(Object.keys(tree(a.root))).toHaveLength(5);
    });

    row({ id: 'machine.root-gone', area, gesture: 'The synced folder is missing when a pass starts', expected: 'Safety stop, nothing touched' }, async () => {
        const w = await seeded();
        renameSync(w.a.root, `${w.a.root}-away`);
        await expect(w.a.engine.cycle()).rejects.toThrow();
        expect(trashed(w)).toBe(0);
        renameSync(`${w.a.root}-away`, w.a.root);
        await w.settle();
    });

    row({ id: 'machine.root-emptied', area, gesture: 'The synced folder is suddenly empty, marker kept', expected: 'Safety stop, nothing deleted on the Drive' }, async () => {
        const w = await seeded();
        for (const n of readdirSync(w.a.root)) if (!n.startsWith('.proton-sync')) rmSync(w.a.abs(n), { recursive: true });
        await expect(w.a.engine.cycle()).rejects.toThrow('empty');
        expect(trashed(w)).toBe(0);
    });

    row({ id: 'machine.marker-gone', area, gesture: 'The folder is there but is not the synced one (marker missing)', expected: 'Safety stop, nothing touched' }, async () => {
        const w = await seeded();
        rmSync(w.a.abs('.proton-sync-root'));
        await expect(w.a.engine.cycle()).rejects.toThrow('marker');
        expect(trashed(w)).toBe(0);
    });

    row({ id: 'machine.restore-backup', area, gesture: 'The folder is restored from a backup: every inode is new', expected: 'Recognised at the same place: no transfer, no deletion' }, async () => {
        const w = await seeded();
        const ids = Object.keys(w.hub.tree()).map((p) => w.web.node(p).id);
        const backup = `${w.a.root}-backup`;
        cpSync(w.a.root, backup, { recursive: true, preserveTimestamps: true });
        rmSync(w.a.root, { recursive: true });
        renameSync(backup, w.a.root);
        await w.settle();
        w.assertConverged();
        expect(Object.keys(w.hub.tree()).map((p) => w.web.node(p).id)).toEqual(ids);
        expect(trashed(w)).toBe(0);
    });

    row({ id: 'machine.out-and-back', area, gesture: 'A folder is moved out of the synced folder, then back', expected: 'Deleted then recreated, content intact everywhere' }, async () => {
        const w = await seeded();
        const away = path.join(w.a.home, 'dehors');
        renameSync(w.a.abs('Albums'), away);
        await w.settle();
        expect(w.exists(w.b, 'Albums')).toBe(false);
        renameSync(away, w.a.abs('Albums'));
        await w.settle();
        w.assertConverged();
        expect(tree(w.b.root)['Albums/a.jpg']).toBe('contenu Albums/a.jpg');
    });

    row({ id: 'machine.inode-reuse', area, gesture: 'A deleted file\'s inode is reused by a new, unrelated file (common on Linux)', expected: 'Seen as a rename and an edit: the old content stays in the history' }, async () => {
        const w = await seeded();
        const rec = w.a.store.all().find((r) => r.name === 'z.txt')!;
        rmSync(w.a.abs('z.txt'));
        w.write(w.a, 'Notes/autre.txt', 'sans rapport');
        const st = statSync(w.a.abs('Notes/autre.txt'));
        w.a.store.put({ ...rec, localId: `${st.dev}:${st.ino}` });
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'machine.inode-reuse-kind', area, gesture: 'A deleted file\'s inode is reused by a new folder', expected: 'No confusion: file deleted, folder created, content recoverable' }, async () => {
        const w = await seeded();
        const rec = w.a.store.all().find((r) => r.name === 'z.txt')!;
        rmSync(w.a.abs('z.txt'));
        w.write(w.a, 'Nouveau/x.txt', 'x');
        const st = statSync(w.a.abs('Nouveau'));
        w.a.store.put({ ...rec, localId: `${st.dev}:${st.ino}` });
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'machine.clock-back', area, gesture: 'The clock goes back: an edited file has an older date', expected: 'The edit is still uploaded' }, async () => {
        const w = await seeded();
        writeFileSync(w.a.abs('z.txt'), 'edit du passé');
        utimesSync(w.a.abs('z.txt'), new Date('2001-01-01'), new Date('2001-01-01'));
        await w.settle();
        w.assertConverged();
        expect(tree(w.b.root)['z.txt']).toBe('edit du passé');
    });

    row({ id: 'machine.base-lost', area, gesture: 'The local database is deleted', expected: 'Treated as a first run: everything re-paired, no deletion, no transfer' }, async () => {
        const w = await seeded();
        w.a.store.close();
        for (const f of readdirSync(w.a.home)) if (f.startsWith('state.sqlite')) rmSync(path.join(w.a.home, f));
        const again = machine('A', w.hub, { home: w.a.home });
        const plan = await again.engine.planOnly();
        expect(new Set(plan.actions.map((x) => x.t))).toEqual(new Set(['link']));
        await settle(again);
        expect(trashed(w)).toBe(0);
    });

    row({ id: 'machine.base-corrupted', area, gesture: 'The local database is corrupted', expected: 'The daemon refuses to run, no file is touched' }, async () => {
        const w = await seeded();
        w.a.store.close();
        for (const f of readdirSync(w.a.home)) if (f.startsWith('state.sqlite')) rmSync(path.join(w.a.home, f));
        writeFileSync(w.a.dbPath, 'ceci n est pas une base '.repeat(100));
        expect(() => machine('A', w.hub, { home: w.a.home })).toThrow();
        expect(Object.keys(tree(w.a.root))).toHaveLength(6);
        expect(trashed(w)).toBe(0);
    });

    for (const at of [3, 12, 25]) {
        row({ id: `machine.kill9-upload-${at}`, area, gesture: `Daemon killed with kill -9 after ${at} of 40 uploads`, expected: 'The next start finishes the job: no duplicate, nothing lost' }, async () => {
            const home = mkdtempSync(path.join(tmpdir(), 'proton-sync-kill-'));
            try {
                const root = path.join(home, ROOT_HINT);
                mkdirSync(root);
                for (let i = 0; i < 40; i++) writeFileSync(path.join(root, `f${i}.txt`), `contenu ${i}`);
                const hubFile = path.join(home, 'hub.json');
                saveHub(new Hub(), hubFile);
                const seed = machine('A', new Hub(), { home });
                seed.store.close();
                const p = Bun.spawn([process.execPath, child, home, hubFile], { stdout: 'ignore', stderr: 'ignore' });
                while (!p.killed && loadHub(hubFile).nodes.size < at) {
                    if (p.exitCode !== null) throw new Error('child ended before the kill');
                    await Bun.sleep(1);
                }
                p.kill('SIGKILL');
                await p.exited;
                const done = loadHub(hubFile).nodes.size;
                expect(done).toBeLessThan(40);
                const hub = loadHub(hubFile);
                const again = machine('A', hub, { home });
                await settle(again);
                again.store.close();
                expect(Object.keys(hub.tree())).toHaveLength(40);
                expect(Object.keys(tree(root))).toHaveLength(40);
            } finally {
                rmSync(home, { recursive: true, force: true });
            }
        });
    }

    row({ id: 'machine.kill9-download', area, gesture: 'Daemon killed with kill -9 in the middle of downloads', expected: 'The next start finishes the job, no half-written file visible' }, async () => {
        const home = mkdtempSync(path.join(tmpdir(), 'proton-sync-kill-'));
        try {
            const hub = new Hub();
            for (let i = 0; i < 40; i++) hub.add('__root__', `f${i}.txt`, 'file', `contenu ${i}`);
            const hubFile = path.join(home, 'hub.json');
            saveHub(hub, hubFile);
            const seed = machine('A', new Hub(), { home });
            seed.store.close();
            const root = path.join(home, ROOT_HINT);
            const p = Bun.spawn([process.execPath, child, home, hubFile], { stdout: 'ignore', stderr: 'ignore' });
            while (readdirSync(root).filter((n) => !n.startsWith('.')).length < 10) {
                if (p.exitCode !== null) throw new Error('child ended before the kill');
                await Bun.sleep(1);
            }
            p.kill('SIGKILL');
            await p.exited;
            for (const [k, v] of Object.entries(tree(root))) expect(v).toBe(hub.tree()[k]!);
            const again = machine('A', hub, { home });
            await settle(again);
            again.store.close();
            expect(tree(root)).toEqual(hub.tree());
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    row({ id: 'machine.second-daemon', area, gesture: 'A second daemon is started on the same configuration', expected: 'It refuses to start' }, async () => {
        const home = mkdtempSync(path.join(tmpdir(), 'proton-sync-lock-'));
        try {
            writeFileSync(path.join(home, 'config.json'), JSON.stringify({ localRoot: home, remote: 'device:x/y', deviceName: 't', maxDeletes: 20 }));
            writeFileSync(path.join(home, 'daemon.lock'), String(process.pid));
            const p = Bun.spawn([process.execPath, main, 'run'], { env: { ...process.env, PROTON_SYNC_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
            const err = await new Response(p.stderr).text();
            expect(await p.exited).not.toBe(0);
            expect(err).toContain('already running');
            expect(existsSync(path.join(home, 'daemon.lock'))).toBe(true);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    row({ id: 'machine.long-sleep', area, gesture: 'The laptop sleeps for days while everything changes elsewhere', expected: 'On wake it catches up, conflicts keep both versions', status: 'trial', note: 'The effect is tested here. A real sleep and wake is confirmed by the trial.' }, async () => {
        const w = await seeded();
        w.write(w.a, 'z.txt', 'modifié pendant que B dort');
        w.write(w.b, 'z.txt', 'modifié sur B avant de dormir');
        w.web.trash('Notes/n.md');
        w.web.write('Albums/nouveau.jpg', 'nouveau');
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'machine.reboot', area, gesture: 'The machine reboots', expected: 'A new process resumes from the base, nothing transferred again', status: 'trial', note: 'A restart is tested here. A real reboot is confirmed by the trial.' }, async () => {
        const w = await seeded();
        w.a.store.close();
        const again = machine('A', w.hub, { home: w.a.home });
        expect((await again.engine.planOnly()).actions).toEqual([]);
    });
});
