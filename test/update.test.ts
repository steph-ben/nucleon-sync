import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseAppVersion } from '../src/names';
import { planUninstall, runUninstall } from '../src/uninstall';
import { checkForUpdate, compareVersions, decideUpdate, fetchLatest, isInstalledLayout, runningVersion, runUpdate, switchVersion } from '../src/desktop/update';

const tempHome = () => mkdtempSync(path.join(tmpdir(), 'nucleon-update-'));

/** An installed layout: app/versions/<v>/bin/nucleon-sync for each version, current -> the first one. */
function installed(home: string, versions: string[], current: string) {
    const app = path.join(home, '.local/share/nucleon-sync/app');
    for (const v of versions) mkdirSync(path.join(app, 'versions', v, 'bin'), { recursive: true });
    symlinkSync(`versions/${current}`, path.join(app, 'current'));
    return app;
}

describe('versions', () => {
    test('same or older latest means none', () => {
        expect(decideUpdate({ current: '0.2.0', latest: '0.2.0' })).toBe('none');
        expect(decideUpdate({ current: '0.2.1', latest: '0.2.0' })).toBe('none');
        expect(decideUpdate({ current: '0.2.0', latest: undefined })).toBe('none');
        expect(decideUpdate({ current: '0.2.0', latest: 'garbage' })).toBe('none');
    });
    test('a newer latest means install', () => {
        expect(decideUpdate({ current: '0.2.0', latest: '0.2.1' })).toBe('install');
        expect(decideUpdate({ current: '0.9.0', latest: '0.10.0' })).toBe('install');
    });
    test('a stable release is newer than a beta of the same number', () => {
        expect(compareVersions('0.2.0', '0.2.0-beta')).toBeGreaterThan(0);
        expect(compareVersions('0.2.0-beta', '0.2.0')).toBeLessThan(0);
        expect(decideUpdate({ current: '0.2.0-beta', latest: '0.2.0' })).toBe('install');
        expect(decideUpdate({ current: '0.2.0-beta', latest: '0.2.0-beta' })).toBe('none');
        expect(decideUpdate({ current: '0.2.0-beta', latest: '0.3.0-beta' })).toBe('install');
        expect(decideUpdate({ current: '0.2.1', latest: '0.2.1-beta' })).toBe('none');
    });
});

describe('fetchLatest', () => {
    const answer = (body: unknown, ok = true) => async (url: string) => {
        urls.push(url);
        return { ok, json: async () => body };
    };
    let urls: string[] = [];
    test('a stable running version asks for the latest release', async () => {
        urls = [];
        expect(await fetchLatest('0.2.0', answer({ tag_name: 'v0.3.0' }))).toBe('0.3.0');
        expect(urls).toEqual(['https://api.github.com/repos/steph-ben/nucleon-sync/releases/latest']);
    });
    test('a beta running version asks for the newest release, prereleases included', async () => {
        urls = [];
        expect(await fetchLatest('0.2.0-beta', answer([{ tag_name: 'v0.2.1-beta' }]))).toBe('0.2.1-beta');
        expect(urls).toEqual(['https://api.github.com/repos/steph-ben/nucleon-sync/releases?per_page=1']);
    });
    test('no network or a bad answer gives undefined', async () => {
        expect(await fetchLatest('0.2.0', async () => { throw new Error('offline'); })).toBeUndefined();
        expect(await fetchLatest('0.2.0', answer({}, false))).toBeUndefined();
        expect(await fetchLatest('0.2.0', answer({ tag_name: 'nonsense' }))).toBeUndefined();
        expect(await fetchLatest('0.2.0-beta', answer([]))).toBeUndefined();
    });
});

describe('switchVersion', () => {
    test('a healthy version keeps the new link', () => {
        const app = installed(tempHome(), ['0.2.0', '0.3.0'], '0.2.0');
        expect(switchVersion(app, '0.3.0', () => true)).toBe('switched');
        expect(readlinkSync(path.join(app, 'current'))).toBe('versions/0.3.0');
    });
    test('a version that fails its health check rolls the link back', () => {
        const app = installed(tempHome(), ['0.2.0', '0.3.0'], '0.2.0');
        expect(switchVersion(app, '0.3.0', () => false)).toBe('rolled-back');
        expect(readlinkSync(path.join(app, 'current'))).toBe('versions/0.2.0');
    });
    test('a health check that throws also rolls back', () => {
        const app = installed(tempHome(), ['0.2.0', '0.3.0'], '0.2.0');
        expect(switchVersion(app, '0.3.0', () => { throw new Error('boom'); })).toBe('rolled-back');
        expect(readlinkSync(path.join(app, 'current'))).toBe('versions/0.2.0');
    });
});

describe('installed layout', () => {
    test('only code under app/versions counts', () => {
        const home = tempHome();
        const app = installed(home, ['0.2.0'], '0.2.0');
        expect(isInstalledLayout(path.join(app, 'versions/0.2.0'), app)).toBe(true);
        expect(isInstalledLayout(path.join(app, 'versions/0.2.0/bin'), app)).toBe(true);
        expect(isInstalledLayout('/home/dev/nucleon-sync/src', app)).toBe(false);
    });
});

describe('runUpdate', () => {
    function setup(versions = ['0.2.0'], current = '0.2.0') {
        const home = tempHome();
        const app = installed(home, versions, current);
        const calls: string[] = [];
        const deps = {
            appDir: app,
            codeDir: path.join(app, 'versions', current),
            current,
            fetch: async (url: string) => {
                calls.push(`fetch ${url}`);
                if (url.endsWith('/install.sh')) return { ok: true, json: async () => ({}), text: async () => '#!/bin/sh\n' };
                return { ok: true, json: async () => ({ tag_name: 'v0.3.0' }), text: async () => '' };
            },
            run: (cmd: string[], env?: Record<string, string>) => {
                calls.push(`run ${cmd.join(' ')} ${env?.NUCLEON_SWITCH ?? ''}`.trim());
                // The installer unpacks the new version, like install.sh does.
                if (cmd[0] === 'sh') mkdirSync(path.join(app, 'versions/0.3.0/bin'), { recursive: true });
                return 0;
            },
            // What the real command prints, built by the same function as APP_VERSION.
            output: (cmd: string[]) => (cmd[0]?.includes('versions/0.3.0') ? releaseAppVersion('0.3.0') : ''),
            serviceInstalled: () => true,
            restart: () => (calls.push('restart'), true),
            serviceIsActive: () => true,
            wait: async () => {},
        };
        return { app, calls, deps };
    }
    test('installs without switching, then switches, restarts and prunes', async () => {
        const { app, calls, deps } = setup(['0.1.0', '0.2.0'], '0.2.0');
        const message = await runUpdate(deps);
        expect(message).toContain('updated to 0.3.0');
        expect(calls.some((c) => c.startsWith('run sh ') && c.endsWith('0'))).toBe(true);
        expect(readlinkSync(path.join(app, 'current'))).toBe('versions/0.3.0');
        expect(calls.at(-1)).toBe('restart');
        expect(existsSync(path.join(app, 'versions/0.2.0'))).toBe(true);
        expect(existsSync(path.join(app, 'versions/0.1.0'))).toBe(false);
    });
    test('a new version that does not start is rolled back and not restarted', async () => {
        const { app, calls, deps } = setup();
        const message = await runUpdate({ ...deps, output: () => 'crash' });
        expect(message).toContain('rolled back');
        expect(readlinkSync(path.join(app, 'current'))).toBe('versions/0.2.0');
        expect(calls).not.toContain('restart');
        expect(existsSync(path.join(app, 'versions/0.3.0'))).toBe(false);
    });
    test('the version output must match exactly', async () => {
        expect(releaseAppVersion('0.3.0-beta')).toBe('external-drive-nucleon_sync@0.3.0-beta');
        const { app, deps } = setup();
        const message = await runUpdate({ ...deps, output: () => releaseAppVersion('0.3.01') });
        expect(message).toContain('rolled back');
        expect(readlinkSync(path.join(app, 'current'))).toBe('versions/0.2.0');
    });
    test('a restart that fails puts the link back, restarts again and prunes nothing', async () => {
        const { app, calls, deps } = setup(['0.1.0', '0.2.0'], '0.2.0');
        let restarts = 0;
        const message = await runUpdate({ ...deps, restart: () => (restarts++, calls.push('restart'), restarts > 1) });
        expect(message).toContain('did not stay up');
        expect(restarts).toBe(2);
        expect(readlinkSync(path.join(app, 'current'))).toBe('versions/0.2.0');
        expect(existsSync(path.join(app, 'versions/0.1.0'))).toBe(true);
        expect(existsSync(path.join(app, 'versions/0.3.0'))).toBe(false);
    });
    test('the running version is the folder after versions, at any depth', () => {
        const app = installed(tempHome(), ['0.2.0'], '0.2.0');
        mkdirSync(path.join(app, 'versions/0.2.0/src'), { recursive: true });
        expect(runningVersion(path.join(app, 'versions/0.2.0'))).toBe('0.2.0');
        expect(runningVersion(path.join(app, 'versions/0.2.0/src'))).toBe('0.2.0');
        expect(runningVersion('/home/dev/nucleon-sync/src')).toBeUndefined();
    });
    test('the running version is never removed when it differs from the previous one', async () => {
        const { app, deps } = setup(['0.1.0', '0.2.0'], '0.2.0');
        mkdirSync(path.join(app, 'versions/0.2.0/src'), { recursive: true });
        // Running from 0.1.0 while current points to 0.2.0.
        const message = await runUpdate({ ...deps, codeDir: path.join(app, 'versions/0.1.0/bin'), serviceIsActive: () => false });
        expect(message).toContain('rolled back');
        expect(existsSync(path.join(app, 'versions/0.1.0'))).toBe(true);
    });
    test('a second restart that fails is reported plainly', async () => {
        const { deps } = setup();
        const message = await runUpdate({ ...deps, restart: () => false });
        expect(message).toContain('could not be restarted');
        expect(message).toContain('systemctl --user restart');
    });
    test('a service that dies after the restart puts the link back', async () => {
        const { app, deps } = setup(['0.1.0', '0.2.0'], '0.2.0');
        const message = await runUpdate({ ...deps, serviceIsActive: () => false });
        expect(message).toContain('did not stay up');
        expect(readlinkSync(path.join(app, 'current'))).toBe('versions/0.2.0');
        expect(existsSync(path.join(app, 'versions/0.1.0'))).toBe(true);
    });
    test('without a service nothing is restarted, and it says so', async () => {
        const { calls, deps } = setup();
        const message = await runUpdate({ ...deps, serviceInstalled: () => false });
        expect(message).toContain('No service is installed');
        expect(calls).not.toContain('restart');
    });
    test('a current that is not a link is treated as not installed', async () => {
        const { app, calls, deps } = setup();
        rmSync(path.join(app, 'current'));
        mkdirSync(path.join(app, 'current'));
        expect(await runUpdate(deps)).toContain('not installed');
        expect(calls).toEqual([]);
    });
    test('up to date or no network changes nothing', async () => {
        const { calls, deps } = setup();
        expect(await runUpdate({ ...deps, current: '0.3.0' })).toBe('up to date');
        expect(await runUpdate({ ...deps, fetch: async () => { throw new Error('offline'); } })).toBe('no update check');
        expect(calls.some((c) => c.startsWith('run'))).toBe(false);
    });
    test('a developer checkout is told so and nothing happens', async () => {
        const { calls, deps } = setup();
        const message = await runUpdate({ ...deps, codeDir: '/home/dev/nucleon-sync/src' });
        expect(message).toContain('not installed');
        expect(calls).toEqual([]);
    });
});

describe('daily check', () => {
    test('notifies once per new version, never installs', async () => {
        const home = tempHome();
        const file = path.join(home, 'update-notified');
        const notes: string[] = [];
        const deps = { current: '0.2.0', fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.3.0' }) }), notify: (n: { body: string }) => notes.push(n.body), notifiedFile: file };
        expect(await checkForUpdate(deps)).toBe('update available');
        expect(await checkForUpdate(deps)).toBe('update available');
        expect(notes).toEqual(['update available: run nucleon-sync update']);
        expect(readFileSync(file, 'utf8')).toBe('0.3.0');
        const newer = { ...deps, fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.4.0' }) }) };
        await checkForUpdate(newer);
        expect(notes.length).toBe(2);
    });
    test('no network gives no update check and no notification', async () => {
        const notes: unknown[] = [];
        const r = await checkForUpdate({ current: '0.2.0', fetch: async () => { throw new Error('x'); }, notify: (n) => notes.push(n), notifiedFile: '/nonexistent/x' });
        expect(r).toBe('no update check');
        expect(notes).toEqual([]);
    });
});

describe('uninstall plan', () => {
    const home = '/home/u';
    test('uninstall never lists the synced folder or, by default, the data folder', () => {
        const plan = planUninstall(home, true);
        expect(plan).not.toContain('/home/u/.local/share/nucleon-sync');
        expect(plan.join('\n')).not.toContain('/home/u/Proton');
        expect(planUninstall(home, false)).toContain('/home/u/.local/share/nucleon-sync');
    });
    test('uninstall lists the service, the command link and the program folder', () => {
        const plan = planUninstall(home, true);
        expect(plan).toContain('service nucleon-sync.service');
        expect(plan).toContain('service org.nucleonsync.daemon');
        expect(plan).toContain('/home/u/.config/systemd/user/nucleon-sync.service');
        expect(plan).toContain('/home/u/Library/LaunchAgents/org.nucleonsync.daemon.plist');
        expect(plan).toContain('/home/u/.local/bin/nucleon-sync');
        expect(plan).toContain('/home/u/.local/share/nucleon-sync/app');
    });
});

describe('runUninstall', () => {
    function setup() {
        const home = tempHome();
        const app = installed(home, ['0.2.0'], '0.2.0');
        const data = path.dirname(app);
        mkdirSync(path.join(home, '.local/bin'), { recursive: true });
        symlinkSync(path.join(app, 'current/bin/nucleon-sync'), path.join(home, '.local/bin/nucleon-sync'));
        mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true });
        writeFileSync(path.join(home, '.config/systemd/user/nucleon-sync.service'), '[Unit]');
        writeFileSync(path.join(data, 'config.json'), '{}');
        mkdirSync(path.join(home, 'Proton'));
        writeFileSync(path.join(home, 'Proton/a.txt'), 'mine');
        const out: string[] = [];
        const cmds: string[] = [];
        const base = { home, platform: 'linux' as const, syncedFolder: path.join(home, 'Proton'), print: (s: string) => out.push(s), run: (c: string[]) => (cmds.push(c.join(' ')), 0) };
        return { home, app, data, out, cmds, base };
    }
    test('without confirmation nothing happens', async () => {
        const { app, cmds, base } = setup();
        await runUninstall({ ...base, purgeData: false, ask: async () => false });
        expect(existsSync(app)).toBe(true);
        expect(cmds).toEqual([]);
    });
    test('removes service, link and app, keeps data and the synced folder', async () => {
        const { home, app, data, out, cmds, base } = setup();
        await runUninstall({ ...base, purgeData: false, ask: async () => true });
        expect(cmds).toContain('systemctl --user disable --now nucleon-sync.service');
        expect(existsSync(app)).toBe(false);
        expect(existsSync(path.join(home, '.config/systemd/user/nucleon-sync.service'))).toBe(false);
        expect(() => lstatSync(path.join(home, '.local/bin/nucleon-sync'))).toThrow();
        expect(existsSync(path.join(data, 'config.json'))).toBe(true);
        expect(readFileSync(path.join(home, 'Proton/a.txt'), 'utf8')).toBe('mine');
        expect(out.join('\n')).toContain(path.join(home, 'Proton'));
    });
    test('purge asks twice and warns about the quarantine', async () => {
        const { data, out, base } = setup();
        const questions: string[] = [];
        await runUninstall({ ...base, purgeData: true, ask: async (q) => (questions.push(q), true) });
        expect(questions.length).toBe(2);
        expect(questions[1]).toContain('quarantine');
        expect(existsSync(data)).toBe(false);
        expect(existsSync(path.join(base.syncedFolder, 'a.txt'))).toBe(true);
        expect(out.length).toBeGreaterThan(0);
    });
    test('a service that cannot be stopped aborts before any removal', async () => {
        const { app, out, base } = setup();
        const run = (c: string[]) => (c.includes('disable') ? 1 : 0);
        await runUninstall({ ...base, run, purgeData: false, ask: async () => true });
        expect(existsSync(app)).toBe(true);
        expect(out.join('\n')).toContain('systemctl --user disable --now nucleon-sync.service');
    });
    test('an absent service (no unit file) is not a failure', async () => {
        const { app, base } = setup();
        rmSync(path.join(base.home, '.config/systemd/user/nucleon-sync.service'));
        const run = (c: string[]) => (c.includes('disable') ? 1 : 0);
        await runUninstall({ ...base, run, purgeData: false, ask: async () => true });
        expect(existsSync(app)).toBe(false);
    });
    test('the tray is stopped by a narrow pattern', async () => {
        const { cmds, base } = setup();
        await runUninstall({ ...base, purgeData: false, ask: async () => true });
        expect(cmds.find((c) => c.startsWith('pkill'))).toContain("python3 .*nucleon-sync-tray\\.py");
    });
    test('a systemctl failure such as no user bus aborts before removal', async () => {
        const { app, out, base } = setup();
        const run = (c: string[]) => (c[0] === 'systemctl' ? 1 : 0);
        await runUninstall({ ...base, run, purgeData: false, ask: async () => true });
        expect(existsSync(app)).toBe(true);
        expect(out.join('\n')).toContain('systemctl --user disable --now');
    });
    test('a command link to a sibling folder app-old is not ours', async () => {
        const { home, data, base } = setup();
        const link = path.join(home, '.local/bin/nucleon-sync');
        rmSync(link);
        symlinkSync(path.join(data, 'app-old/bin/nucleon-sync'), link);
        await runUninstall({ ...base, purgeData: false, ask: async () => true });
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });
    test('purge is refused when the synced folder is inside the data folder', async () => {
        const { data, out, cmds, base } = setup();
        const inside = path.join(data, 'synced');
        mkdirSync(inside);
        const viaLink = path.join(base.home, 'Link');
        symlinkSync(inside, viaLink);
        for (const folder of [inside, viaLink]) {
            await runUninstall({ ...base, syncedFolder: folder, purgeData: true, ask: async () => true });
            expect(existsSync(inside)).toBe(true);
        }
        expect(cmds).toEqual([]);
        expect(out.join('\n')).toContain('Refusing --purge-data');
    });
    test('refusing the second confirmation keeps the data', async () => {
        const { data, base } = setup();
        let n = 0;
        await runUninstall({ ...base, purgeData: true, ask: async () => ++n === 1 });
        expect(existsSync(data)).toBe(true);
    });
});
