import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type DesktopState, notificationsFor, render, writeState } from '../src/desktop/state';
import { makeIgnore } from '../src/desktop/exclude';
import { DesktopTracker } from '../src/desktop/tracker';
import { recentActivity } from '../src/desktop/activity';
import { noteCommand } from '../src/desktop/notify';
import { buildConfig } from '../src/desktop/setup';
import { decideUpdate } from '../src/desktop/update';
import { cleanWorlds, machine, settle, tree } from './lib/world';
import { Hub } from './sim';

const hasPython = Bun.which('python3') !== null;
const idle: DesktopState = { pid: 1, heartbeatAt: 1000, paused: false, syncing: false, lastSyncAt: 900, problems: [], held: 0, unseenDeletes: [], conflicts: 0 };

describe('render', () => {
    test('all good says when it last synced', () => {
        const v = render(idle, 1000 + 120000);
        expect(v.level).toBe('ok');
        expect(v.title).toBe('Up to date');
    });
    test('a transfer shows its progress', () => {
        const v = render({ ...idle, syncing: true, transfer: { done: 2, total: 5, current: 'Notes/a.md' } }, 1000);
        expect(v.level).toBe('syncing');
        expect(v.title).toBe('Syncing 2/5');
        expect(v.lines).toContain('Notes/a.md');
    });
    test('pause wins over everything but problems', () => {
        expect(render({ ...idle, paused: true }, 1000).level).toBe('paused');
        expect(render({ ...idle, paused: true, problems: [{ kind: 'session', message: 'x' }] }, 1000).level).toBe('attention');
    });
    test('held deletions and new deletions are visible', () => {
        const v = render({ ...idle, held: 25, unseenDeletes: ['a.txt', 'b.txt'] }, 1000);
        expect(v.level).toBe('attention');
        expect(v.lines.join('\n')).toContain('25 deletions');
        expect(v.lines.join('\n')).toContain('2 files');
    });
});

describe('notifications come from transitions only', () => {
    test('nothing when nothing changed', () => {
        expect(notificationsFor(idle, idle)).toEqual([]);
    });
    test('a new problem notifies once', () => {
        const next = { ...idle, problems: [{ kind: 'session' as const, message: 'Log in again' }] };
        expect(notificationsFor(idle, next)).toHaveLength(1);
        expect(notificationsFor(next, next)).toEqual([]);
    });
    test('new held deletions, conflicts and deletions notify', () => {
        expect(notificationsFor(idle, { ...idle, held: 25 })[0]!.title).toContain('25');
        expect(notificationsFor(idle, { ...idle, conflicts: 1 })[0]!.title).toContain('onflict');
        expect(notificationsFor(idle, { ...idle, unseenDeletes: ['a'] })[0]!.body).toContain('a');
    });
    test('the first state after a start does not replay old problems', () => {
        expect(notificationsFor(undefined, { ...idle, held: 25 })).toEqual([]);
    });
    test('the end of a problem is said too', () => {
        const bad = { ...idle, problems: [{ kind: 'failing' as const, message: 'x' }] };
        expect(notificationsFor(bad, idle)[0]!.title).toContain('restored');
    });
});

test('the state file is complete JSON with the rendered view', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'nucleon-sync-state-')), 'desktop.json');
    writeState(file, idle, 2000);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.heartbeatAt).toBe(1000);
    expect(saved.view.title).toBe('Up to date');
});

describe('exclusions', () => {
    const ig = makeIgnore(['*.tmp', 'Cache/', 'brouillon?.md']);
    test('name patterns', () => {
        expect(ig('a.tmp', false)).toBe(true);
        expect(ig('brouillon1.md', false)).toBe(true);
        expect(ig('brouillon12.md', false)).toBe(false);
        expect(ig('photo.jpg', false)).toBe(false);
    });
    test('a trailing slash only matches folders', () => {
        expect(ig('Cache', true)).toBe(true);
        expect(ig('Cache', false)).toBe(false);
    });
    test('default exclusions still apply', () => {
        expect(ig('.DS_Store', false)).toBe(true);
    });
    test('regex characters in a pattern are literal', () => {
        expect(makeIgnore(['a+b.txt'])('a+b.txt', false)).toBe(true);
        expect(makeIgnore(['a+b.txt'])('aab.txt', false)).toBe(false);
    });
});

afterEach(cleanWorlds);

test('excluding an already synced folder deletes nothing, on either side', async () => {
    const hub = new Hub();
    let exclude = false;
    const a = machine('A', hub, { ignore: (name) => exclude && name === 'Cache' });
    const b = machine('B', hub, {});
    a.engine;
    await Bun.write(a.abs('Cache/x.bin'), 'cache');
    await Bun.write(a.abs('Notes/n.md'), 'note');
    await settle(a, b);
    exclude = true;
    await settle(a, b);
    expect(tree(a.root)['Cache/x.bin']).toBe('cache');
    expect(hub.tree()['Cache/x.bin']).toBe('cache');
    expect(tree(b.root)['Cache/x.bin']).toBe('cache');
    await Bun.write(a.abs('Notes/n.md'), 'note 2');
    await settle(a, b);
    expect(tree(b.root)['Notes/n.md']).toBe('note 2');
});

function tracker() {
    const kv = new Map<string, string>();
    const notes: { title: string; body: string }[] = [];
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'nucleon-sync-track-')), 'desktop.json');
    let now = 1000;
    const t = new DesktopTracker(file, 1, { getKv: (k) => kv.get(k), setKv: (k, v) => void kv.set(k, v) }, (n) => notes.push(n), () => now, () => false);
    return { t, kv, notes, file, tick: (ms: number) => (now += ms) };
}
const plan = { rebinds: [], actions: [], held: [], warnings: [] };
const done = { plan, done: 0, skipped: 0, errors: [], deleted: [], conflicts: 0 };

describe('DesktopTracker', () => {
    test('a run of failures becomes a problem, one success clears it', () => {
        const { t, notes } = tracker();
        t.passDone(done);
        t.passFailed(new Error('network unreachable'), false);
        expect(notes).toHaveLength(0);
        t.passFailed(new Error('network unreachable'), false);
        t.passFailed(new Error('network unreachable'), false);
        expect(notes).toHaveLength(1);
        t.passDone(done);
        expect(notes[1]!.title).toContain('restored');
    });
    test('an expired session is a problem at once, and says what to do', () => {
        const { t, notes } = tracker();
        t.passDone(done);
        t.passFailed(new Error('session expired: 401'), false);
        expect(notes[0]!.body).toContain('nucleon-sync login');
    });
    test('a safety stop is a problem at once', () => {
        const { t, notes } = tracker();
        t.passDone(done);
        t.passFailed(new Error('local folder is empty but the base is not'), true);
        expect(notes[0]!.body).toContain('empty');
    });
    test('deletions stay unseen across a restart until acknowledged', () => {
        const a = tracker();
        a.t.passDone(done);
        a.t.passDone({ ...done, deleted: ['a.txt'] });
        expect(a.notes[0]!.body).toContain('a.txt');
        const again = new DesktopTracker(a.file, 2, { getKv: (k) => a.kv.get(k), setKv: (k, v) => void a.kv.set(k, v) }, () => {}, () => 2000, () => false);
        again.passDone(done);
        expect(JSON.parse(readFileSync(a.file, 'utf8')).unseenDeletes).toEqual(['a.txt']);
        a.kv.set('unseen-deletes', '[]');
        again.flush();
        expect(JSON.parse(readFileSync(a.file, 'utf8')).unseenDeletes).toEqual([]);
    });
    test('an unreadable file shows as a problem', () => {
        const { t } = tracker();
        t.passDone({ ...done, plan: { ...plan, warnings: ['cannot read folder: Albums (EACCES)'] } });
        expect(t.state.problems.map((p) => p.kind)).toEqual(['unreadable']);
    });
    test('the list of unseen deletions stays bounded', () => {
        const { t } = tracker();
        t.passDone({ ...done, deleted: Array.from({ length: 3000 }, (_, i) => `f${i}`) });
        expect(t.state.unseenDeletes.length).toBeLessThanOrEqual(1000);
    });
});

describe('notification command', () => {
    test('macOS: a name never becomes AppleScript', () => {
        const evil = 'x" & (do shell script "rm -rf ~") & "';
        const c = noteCommand('darwin', { title: 't', body: evil });
        expect(c[0]).toBe('osascript');
        expect(c.slice(0, -2).join(' ')).not.toContain('rm -rf');
        expect(c.at(-1)).toBe(evil);
    });
    test('Linux: a name is not an option', () => {
        expect(noteCommand('linux', { title: '-x', body: 'b' })).toEqual(['notify-send', '--app-name=nucleon-sync', '--', '-x', 'b']);
    });
});

describe('commands', () => {
    const main = process.env.NUCLEON_ENTRY ?? path.join(import.meta.dir, '../src/main.ts');
    async function cli(home: string, ...args: string[]) {
        const p = Bun.spawn([process.execPath, main, ...args], { env: { ...process.env, NUCLEON_SYNC_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
        const out = await new Response(p.stdout).text();
        await p.exited;
        return out;
    }
    const home = () => mkdtempSync(path.join(tmpdir(), 'nucleon-sync-cli-'));

    test('pause and resume', async () => {
        const h = home();
        await cli(h, 'pause');
        expect(await Bun.file(path.join(h, 'paused')).exists()).toBe(true);
        await cli(h, 'resume');
        expect(await Bun.file(path.join(h, 'paused')).exists()).toBe(false);
    });
    test('status is readable', async () => {
        const h = home();
        writeState(path.join(h, 'desktop.json'), { ...idle, heartbeatAt: Date.now(), held: 25 }, Date.now());
        const out = await cli(h, 'status');
        expect(out).toContain('Action needed');
        expect(out).toContain('25 deletions');
    });
    test('status says when the daemon is gone', async () => {
        const h = home();
        writeState(path.join(h, 'desktop.json'), { ...idle, heartbeatAt: Date.now() - 600000 }, Date.now());
        expect(await cli(h, 'status')).toContain('stopped');
    });
    test('status with no daemon ever run', async () => {
        expect(await cli(home(), 'status')).toContain('stopped');
    });
    test('exclude add, list, remove', async () => {
        const h = home();
        await Bun.write(path.join(h, 'config.json'), JSON.stringify({ localRoot: h, remote: 'device:x/y', deviceName: 't', maxDeletes: 20 }));
        await cli(h, 'exclude', 'add', '*.tmp');
        expect(await cli(h, 'exclude', 'list')).toContain('*.tmp');
        await cli(h, 'exclude', 'remove', '*.tmp');
        expect(await cli(h, 'exclude', 'list')).not.toContain('*.tmp');
    });
});

describe('setup assistant', () => {
    test('a test space needs no confirmation', () => {
        const c = buildConfig({ folder: '/home/s/Proton', target: 'test', confirmed: false, deviceName: 'fedora' });
        expect(c.remote).toBe('device:nucleon-sync-test/sandbox-fedora');
        expect(c.allowDriveRoot).toBeUndefined();
    });
    test('My files only with an explicit confirmation', () => {
        expect(() => buildConfig({ folder: '/x', target: 'myfiles', confirmed: false, deviceName: 'd' })).toThrow('confirm');
        const c = buildConfig({ folder: '/x', target: 'myfiles', confirmed: true, deviceName: 'd' });
        expect(c.remote).toBe('root');
        expect(c.allowDriveRoot).toBe(true);
    });
});

describe('update decision', () => {
    const base = { branch: 'main', behind: 2, clean: true, ci: 'success' as const };
    test('installed only when CI is green on a clean main', () => {
        expect(decideUpdate(base)).toBe('install');
    });
    test('otherwise only signalled', () => {
        expect(decideUpdate({ ...base, ci: 'failure' })).toBe('signal');
        expect(decideUpdate({ ...base, ci: 'unknown' })).toBe('signal');
        expect(decideUpdate({ ...base, clean: false })).toBe('signal');
    });
    test('nothing to do when up to date or on another branch', () => {
        expect(decideUpdate({ ...base, behind: 0 })).toBe('none');
        expect(decideUpdate({ ...base, branch: 'reliability' })).toBe('none');
    });
});

test.skipIf(!hasPython)('Linux icon: a stale, broken or missing state means stopped', async () => {
    const h = mkdtempSync(path.join(tmpdir(), 'nucleon-sync-py-'));
    const script = path.join(import.meta.dir, '../desktop/linux/nucleon-sync-tray.py');
    const code = `import importlib.util,sys
s=importlib.util.spec_from_file_location("t",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(m.read_state(sys.argv[2],1000)["level"]);print(m.read_state(sys.argv[2],99999)["level"]);print(m.read_state("/nonexistent",1000)["level"])`;
    writeState(path.join(h, 'desktop.json'), { ...idle, heartbeatAt: 1000 * 1000 }, 1000 * 1000);
    const p = Bun.spawn(['python3', '-I', '-c', code, script, h], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(p.stdout).text();
    expect(out.trim().split('\n')).toEqual(['ok', 'stopped', 'stopped']);
});

describe('activity comes from the journal', () => {
    const LOG = [
        '2026-11-05T10:00:00.000Z INFO  pass 1 start: Drive poll',
        '2026-11-05T10:00:01.000Z DEBUG bookkeeping  refresh  a.txt',
        '2026-11-05T10:00:02.000Z INFO  local→drive  upload  Notes/été.md',
        '2026-11-05T10:00:03.000Z INFO  drive→local  download new version  z.txt',
        '2026-11-05T10:00:04.000Z INFO  local→drive  move  A -> B',
        '2026-11-05T10:00:05.000Z INFO  local  conflict copy  a -> b',
        '2026-11-05T10:00:06.000Z WARN  drive→local  download  x (will retry on the next pass)',
        '2026-11-05T10:00:07.000Z ERROR local→drive  upload  b.txt: quota exceeded: try later',
        '2026-11-05T10:00:08.000Z INFO  drive→local  quarantine  vieux.txt',
    ].join('\n');
    const logFile = () => {
        const f = path.join(mkdtempSync(path.join(tmpdir(), 'nucleon-sync-log-')), 'nucleon-sync.log');
        writeFileSync(f, `${LOG}\n`);
        return f;
    };

    test('plain words, newest first, without bookkeeping or retries', () => {
        const rows = recentActivity(logFile(), 10);
        expect(rows.map((r) => [r.label, r.path])).toEqual([
            ['Moved to quarantine', 'vieux.txt'],
            ['Error: Uploaded', 'b.txt'],
            ['Conflict: copy created', 'a -> b'],
            ['Moved on Drive', 'A -> B'],
            ['Downloaded (new version)', 'z.txt'],
            ['Uploaded', 'Notes/été.md'],
        ]);
        expect(rows[1]!.error).toBe('quota exceeded: try later');
    });

    test('only the end of a huge journal is read', () => {
        const f = logFile();
        appendFileSync(f, `${'2026-11-05T09:00:00.000Z INFO  local→drive  upload  old.txt\n'.repeat(200000)}${LOG}\n`);
        const started = performance.now();
        expect(recentActivity(f, 3)).toHaveLength(3);
        expect(performance.now() - started).toBeLessThan(200);
    });

    test('no journal yet', () => {
        expect(recentActivity('/nonexistent/nucleon-sync.log', 10)).toEqual([]);
    });

    test.skipIf(!hasPython)('the Linux window reads the same thing as the command', async () => {
        const f = logFile();
        const script = path.join(import.meta.dir, '../desktop/linux/nucleon-sync-tray.py');
        const code = `import importlib.util,sys,json
s=importlib.util.spec_from_file_location("t",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.read_activity(sys.argv[2]),ensure_ascii=False));print(m.read_activity("/nonexistent"))`;
        const p = Bun.spawn(['python3', '-I', '-c', code, script, path.dirname(f)], { stdout: 'pipe', stderr: 'pipe' });
        const [first, second] = (await new Response(p.stdout).text()).trim().split('\n');
        const expected = recentActivity(f, 200).map((r) => [r.at, r.label, r.path, r.error ?? '']);
        expect(JSON.parse(first!)).toEqual(expected);
        expect(second).toBe('[]');
    });
});
