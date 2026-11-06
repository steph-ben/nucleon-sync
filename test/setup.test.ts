import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installTray, type TrayChecks } from '../src/service';
import { buildConfig, describePlan, expandHome, finalSummary, folderProblem, isYes, sessionStoreProblem } from '../src/desktop/setup';
import { findDeployDir, installService, launchdJobRunning, renderService, serviceIsUp, serviceProblem } from '../src/service';

function tempHome(): string {
    return mkdtempSync(path.join(tmpdir(), 'setup-home-'));
}

function touch(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
}

/** Answers like systemctl and launchctl: `live` maps "command args" to its output, anything else fails. */
describe('session store', () => {
    test('no keyring gives a clear message', async () => {
        const message = await sessionStoreProblem(async () => {
            throw new Error('no secret service');
        });
        expect(message).toContain('PROTON_DRIVE_CREDENTIALS_STORE=pass');
        expect(message).toContain('libsecret');
    });
    test('a working keyring gives no message', async () => {
        expect(await sessionStoreProblem(async () => {})).toBeUndefined();
    });
});

describe('service files', () => {
    const o = { home: '/home/u', dataDir: '/home/u/.local/share/nucleon-sync', command: '/home/u/.local/bin/nucleon-sync' };
    test('the systemd unit points at the installed command and the data dir', () => {
        const unit = renderService('linux', o);
        expect(unit).toContain('ExecStart="/home/u/.local/bin/nucleon-sync" run');
        expect(unit).toContain('Environment="NUCLEON_SYNC_HOME=/home/u/.local/share/nucleon-sync"');
        expect(unit).not.toContain('__');
    });
    test('the launchd plist is labelled org.nucleonsync.daemon and runs the command', () => {
        const plist = renderService('darwin', o);
        expect(plist).toContain('<string>org.nucleonsync.daemon</string>');
        expect(plist).toContain('<string>/home/u/.local/bin/nucleon-sync</string>');
        expect(plist).toContain('<string>/home/u/.local/share/nucleon-sync</string>');
        expect(plist).not.toContain('__');
    });
    test('the credentials store is carried into both service files when it is set', () => {
        const withStore = { ...o, credentialsStore: 'pass' };
        expect(renderService('linux', withStore)).toContain('Environment="PROTON_DRIVE_CREDENTIALS_STORE=pass"');
        const plist = renderService('darwin', withStore);
        expect(plist).toContain('<key>PROTON_DRIVE_CREDENTIALS_STORE</key>');
        expect(plist).toContain('<string>pass</string>');
    });
    test('without a credentials store the variable is not in the service files', () => {
        expect(renderService('linux', o)).not.toContain('CREDENTIALS');
        expect(renderService('darwin', o)).not.toContain('CREDENTIALS');
    });
    test('deploy is found in a checkout (src/) and in the installed layout (versions/<v>/)', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'layout-'));
        const checkout = path.join(root, 'checkout');
        touch(path.join(checkout, 'deploy/nucleon-sync.service'));
        mkdirSync(path.join(checkout, 'src'));
        expect(findDeployDir(path.join(checkout, 'src'))).toBe(path.join(checkout, 'deploy'));
        const version = path.join(root, 'versions/0.2.0');
        touch(path.join(version, 'deploy/nucleon-sync.service'));
        expect(findDeployDir(version)).toBe(path.join(version, 'deploy'));
        expect(() => findDeployDir(root)).toThrow('deploy');
    });
    test('the real templates are found from the running program', () => {
        expect(renderService('linux', o)).toContain('[Service]');
    });
    test('installing on Linux writes the unit then enables it through the runner', () => {
        const home = tempHome();
        const calls: string[][] = [];
        installService('linux', { ...o, home }, (cmd) => (calls.push(cmd), 0));
        const file = path.join(home, '.config/systemd/user/nucleon-sync.service');
        expect(readFileSync(file, 'utf8')).toContain(`Environment="PATH=${home}/.local/bin`);
        expect(calls).toEqual([
            ['systemctl', '--user', 'daemon-reload'],
            ['systemctl', '--user', 'enable', 'nucleon-sync.service'],
            ['systemctl', '--user', 'restart', 'nucleon-sync.service'],
        ]);
    });
    test('installing on macOS removes a previous job, then bootstraps the plist', () => {
        const home = tempHome();
        const calls: string[][] = [];
        installService('darwin', { ...o, home }, (cmd) => (calls.push(cmd), 0));
        const file = path.join(home, 'Library/LaunchAgents/org.nucleonsync.daemon.plist');
        expect(existsSync(file)).toBe(true);
        expect(existsSync(path.join(home, 'Library/Logs'))).toBe(true);
        expect(calls).toHaveLength(2);
        expect(calls[0]!.slice(0, 2)).toEqual(['launchctl', 'bootout']);
        expect(calls[0]![2]).toEndWith('/org.nucleonsync.daemon');
        expect(calls[1]!.slice(0, 2)).toEqual(['launchctl', 'bootstrap']);
        expect(calls[1]![3]).toBe(file);
    });
    test('a macOS rerun does not fail when no previous job was loaded', () => {
        const run = (cmd: string[]) => (cmd[1] === 'bootout' ? 3 : 0);
        expect(() => installService('darwin', { ...o, home: tempHome() }, run)).not.toThrow();
    });
    test('a failing command is reported', () => {
        expect(() => installService('linux', { ...o, home: tempHome() }, () => 1)).toThrow('systemctl');
    });
    test('another system is refused with a clear error', () => {
        expect(() => installService('win32', o, () => 0)).toThrow('Linux and macOS');
    });
});

const CRASH_LOOPING = `gui/501/org.nucleonsync.daemon = {
	active count = 0
	state = spawn scheduled
	program = /Users/u/.local/bin/nucleon-sync
	last exit code = 1
}`;
const RUNNING = `gui/501/org.nucleonsync.daemon = {
	active count = 1
	state = running
	program = /Users/u/.local/bin/nucleon-sync
	pid = 4242
	last exit code = (never exited)
	endpoints = {
		"x" = {
			state = active
		}
	}
}`;

describe('is the service up', () => {
    test('a launchd job needs state = running and a pid', () => {
        expect(launchdJobRunning(RUNNING)).toBe(true);
        expect(launchdJobRunning(CRASH_LOOPING)).toBe(false);
        expect(launchdJobRunning('')).toBe(false);
        expect(launchdJobRunning(RUNNING.replace('\tpid = 4242\n', ''))).toBe(false);
    });
    test('macOS asks launchctl print, not its exit code', () => {
        expect(serviceIsUp('darwin', 501, () => CRASH_LOOPING)).toBe(false);
        expect(serviceIsUp('darwin', 501, (cmd) => (cmd.join(' ') === 'launchctl print gui/501/org.nucleonsync.daemon' ? RUNNING : ''))).toBe(true);
    });
    test('Linux needs active, not activating', () => {
        expect(serviceIsUp('linux', 501, () => 'active\n')).toBe(true);
        expect(serviceIsUp('linux', 501, () => 'activating\n')).toBe(false);
        expect(serviceIsUp('linux', 501, () => '')).toBe(false);
    });
});

describe('setup with a config already there, as after a migration', () => {
    function world(serviceState: string) {
        const home = mkdtempSync(path.join(tmpdir(), 'setup-migrated-'));
        const data = path.join(home, '.local/share/nucleon-sync');
        const bin = path.join(home, 'shims');
        mkdirSync(data, { recursive: true });
        mkdirSync(bin);
        touch(path.join(home, '.local/bin/nucleon-sync'));
        writeFileSync(path.join(data, 'config.json'), JSON.stringify({ localRoot: path.join(home, 'Proton'), remote: 'root', allowDriveRoot: true, deviceName: 'x', maxDeletes: 20 }));
        const log = path.join(home, 'calls.log');
        const printed = serviceState === 'active' ? RUNNING : CRASH_LOOPING;
        writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$2" = is-active ] && echo ${serviceState}\nexit 0\n`, { mode: 0o755 });
        writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = print ] && cat <<'END'\n${printed}\nEND\nexit 0\n`, { mode: 0o755 });
        const main = process.env.NUCLEON_ENTRY ?? path.join(import.meta.dir, '../src/main.ts');
        const r = Bun.spawnSync([process.execPath, main, 'setup'], {
            env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, PROTON_DRIVE_CREDENTIALS_STORE: 'pass' },
            cwd: home,
            stdin: Buffer.from('y\n'),
            stdout: 'pipe',
            stderr: 'pipe',
        });
        return { home, data, log, out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode };
    }

    test('goes straight to the start step and writes the new service', () => {
        const w = world('active');
        expect(w.err).toBe('');
        expect(w.code).toBe(0);
        expect(w.out).toContain('Already configured');
        const service = process.platform === 'darwin' ? 'Library/LaunchAgents/org.nucleonsync.daemon.plist' : '.config/systemd/user/nucleon-sync.service';
        const text = readFileSync(path.join(w.home, service), 'utf8');
        expect(text).toContain(path.join(w.home, '.local/bin/nucleon-sync'));
        expect(text).toContain('PROTON_DRIVE_CREDENTIALS_STORE');
        expect(w.out).toContain('Syncing started');
    });

    test('a service that does not stay up is said plainly, with where to look', () => {
        const w = world('failed');
        expect(w.out).not.toContain('Syncing started');
        expect(w.out).toContain('did not stay up');
        expect(w.out).toContain(path.join(w.data, 'nucleon-sync.log'));
    });
});

describe('folder to sync', () => {
    const data = '/home/u/.local/share/nucleon-sync';
    test('a normal folder is fine', () => {
        expect(folderProblem('/home/u/Proton', '/home/u', data)).toBeUndefined();
        expect(folderProblem('/home/u/.local/share/nucleon-sync-other', '/home/u', data)).toBeUndefined();
    });
    test('the home folder and / are refused', () => {
        expect(folderProblem('/home/u', '/home/u', data)).toContain('home folder');
        expect(folderProblem('/home/u/', '/home/u', data)).toContain('home folder');
        expect(folderProblem('/', '/home/u', data)).toContain('root');
    });
    test('the data folder, a folder inside it and a folder that contains it are refused', () => {
        expect(folderProblem(data, '/home/u', data)).toContain('data folder');
        expect(folderProblem(`${data}/sync`, '/home/u', data)).toContain('data folder');
        expect(folderProblem('/home/u/.local', '/home/u', data)).toContain('data folder');
    });
    test('a link to the data folder is seen through, also for a folder not created yet', () => {
        const home = realpathSync(tempHome());
        const realData = path.join(home, 'data');
        mkdirSync(realData);
        symlinkSync(realData, path.join(home, 'link'));
        expect(folderProblem(path.join(home, 'link'), home, realData)).toContain('data folder');
        expect(folderProblem(path.join(home, 'link/new/deep'), home, realData)).toContain('data folder');
    });
});

describe('My files', () => {
    test('still needs the explicit confirmation', () => {
        expect(() => buildConfig({ folder: '/x', target: 'myfiles', confirmed: false, deviceName: 'd' })).toThrow('confirm');
    });
});

describe('review fixes', () => {
    test('answers: y and yes only; bare ~ expands', () => {
        expect(isYes('Y')).toBe(true);
        expect(isYes('yes')).toBe(true);
        expect(isYes('yep')).toBe(false);
        expect(isYes(null)).toBe(false);
        expect(expandHome('~', '/h')).toBe('/h');
        expect(expandHome('~/P', '/h')).toBe('/h/P');
        expect(expandHome('~x', '/h')).toBe('~x');
    });
    test('a home with a space, a percent and an ampersand is quoted and escaped', () => {
        const o = { home: '/home/a b&c%d', dataDir: '/home/a b&c%d/data', command: '/home/a b&c%d/.local/bin/nucleon-sync' };
        const unit = renderService('linux', o);
        expect(unit).toContain('ExecStart="/home/a b&c%%d/.local/bin/nucleon-sync" run');
        expect(unit).toContain('Environment="NUCLEON_SYNC_HOME=/home/a b&c%%d/data"');
        const plist = renderService('darwin', o);
        expect(plist).toContain('<string>/home/a b&amp;c%d/.local/bin/nucleon-sync</string>');
        expect(plist).not.toContain('b&c');
    });
    test('service problems: unsupported system and missing command', () => {
        expect(serviceProblem('win32')).toContain('Linux and macOS');
        expect(serviceProblem('linux', '/nope', () => false)).toContain('does not exist');
        expect(serviceProblem('linux', '/yes', () => true)).toBeUndefined();
    });
});

describe('the words at the end of setup', () => {
    test('the plan is in plain words, one line per kind of action', () => {
        const lines = describePlan(new Map([['link', 468], ['upload', 1], ['remoteTrash', 2]]));
        expect(lines[0]).toContain('468  already the same on both sides');
        expect(lines[1]).toContain('1  to upload');
        expect(lines[2]).toContain('2  to move to the Proton trash');
        expect(describePlan(new Map())[0]).toContain('nothing to do');
    });
    test('the summary says what was installed, what runs, and where the files are', () => {
        const text = finalSummary({ folder: '/home/a/Documents', remote: 'root', home: '/home/a', dataDir: '/home/a/.local/share/nucleon-sync', os: 'linux', tray: 'started' }).join('\n');
        for (const part of ['~/Documents', 'My files', '~/.local/bin/nucleon-sync', '~/.local/share/nucleon-sync/app', '~/.local/share/nucleon-sync/quarantine', '~/.config/systemd/user/nucleon-sync.service', 'starts at every login', 'system keyring', 'Tray icon       started', 'nucleon-sync uninstall']) {
            expect(text).toContain(part);
        }
    });
});

describe('tray', () => {
    const checks = (over: Partial<TrayChecks> = {}) => {
        const started: string[][] = [];
        return { started, checks: { hasIndicatorLibrary: () => true, gnomeNeedsExtension: () => false, start: (cmd: string[]) => started.push(cmd), ...over } };
    };
    const installed = () => {
        const home = tempHome();
        touch(path.join(home, '.local/share/nucleon-sync/app/current/desktop/linux/nucleon-sync-tray.py'));
        return { home, dataDir: path.join(home, '.local/share/nucleon-sync'), command: path.join(home, '.local/bin/nucleon-sync') };
    };
    test('it starts now and at every login, through the current link', () => {
        const o = installed();
        const c = checks();
        expect(installTray(o, c.checks)).toContain('starts at every login');
        expect(c.started[0]![1]).toContain('app/current/desktop/linux/nucleon-sync-tray.py');
        const entry = readFileSync(path.join(o.home, '.config/autostart/nucleon-sync-tray.desktop'), 'utf8');
        expect(entry).toContain(`${o.home}/.local/share/nucleon-sync/app/current/desktop/linux/nucleon-sync-tray.py`);
        expect(entry).not.toContain('__');
    });
    test('a missing library is named, and nothing is started', () => {
        const c = checks({ hasIndicatorLibrary: () => false });
        const line = installTray(installed(), c.checks);
        expect(line).toContain('libayatana-appindicator-gtk3');
        expect(c.started).toEqual([]);
    });
    test('GNOME without the extension is said plainly', () => {
        expect(installTray(installed(), checks({ gnomeNeedsExtension: () => true }).checks)).toContain('AppIndicator extension');
    });
});
