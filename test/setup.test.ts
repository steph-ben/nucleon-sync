import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildConfig, checkOtherSyncTool, expandHome, isYes, leftoverRcloneFile, liveRcloneUnit, sessionStoreProblem } from '../src/desktop/setup';
import type { RunCommand } from '../src/migrate';
import { findDeployDir, installService, renderService, serviceProblem } from '../src/service';

function tempHome(): string {
    return mkdtempSync(path.join(tmpdir(), 'setup-home-'));
}

function touch(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
}

/** Answers like systemctl and launchctl: `live` maps "command args" to its output, anything else fails. */
function fakeRun(live: Record<string, string> = {}): { run: RunCommand; calls: string[] } {
    const calls: string[] = [];
    const run: RunCommand = (command, args) => {
        const line = [command, ...args].join(' ');
        calls.push(line);
        return line in live ? { status: 0, stdout: `${live[line]}\n` } : { status: 1, stdout: '' };
    };
    return { run, calls };
}

function checkTool(folder: string, home: string, o: { live?: Record<string, string>; answer?: string; env?: Record<string, string> } = {}) {
    const printed: string[] = [];
    const questions: string[] = [];
    const result = () =>
        checkOtherSyncTool(folder, {
            home,
            uid: 501,
            run: fakeRun(o.live).run,
            env: o.env ?? {},
            print: (line) => printed.push(line),
            ask: (question) => (questions.push(question), o.answer ?? null),
        });
    return { result, printed, questions };
}

const DISABLED_LIST = 'disabled services = {\n\t"org.rclone.bisync" => disabled\n}';

describe('other sync tool', () => {
    const cacheFile = (home: string, cache = '.cache/rclone/bisync') => path.join(home, cache, `${home.replace(/^\//, '').replace(/\//g, '_')}_Proton..proton_.path1.lst`);

    test('a leftover rclone file with no live unit needs a typed yes, and names the file', () => {
        const home = tempHome();
        const file = cacheFile(home);
        touch(file);
        const check = checkTool(path.join(home, 'Proton'), home, { answer: 'no' });
        expect(check.result).toThrow('nothing was done');
        expect(check.printed.join('\n')).toContain(file);
        expect(check.questions).toHaveLength(1);
        expect(checkTool(path.join(home, 'Proton'), home, { answer: 'yes' }).result).not.toThrow();
    });
    test('a leftover file with the folder in the middle of its name counts', () => {
        const home = tempHome();
        const name = home.replace(/^\//, '').replace(/\//g, '_');
        touch(path.join(home, '.cache/rclone/bisync', `proton_${name}_Proton.path2.lst`));
        expect(leftoverRcloneFile(path.join(home, 'Proton'), home)).toContain('path2.lst');
    });
    test('a leftover file of another folder asks nothing', () => {
        const home = tempHome();
        touch(cacheFile(home));
        const check = checkTool(path.join(home, 'Other'), home);
        check.result();
        expect(check.questions).toEqual([]);
    });
    test('nothing installed asks nothing', () => {
        const home = tempHome();
        const check = checkTool(path.join(home, 'Proton'), home);
        check.result();
        expect(check.questions).toEqual([]);
        expect(check.printed).toEqual([]);
    });
    test('the macOS cache folder and XDG_CACHE_HOME are searched', () => {
        const home = tempHome();
        const xdg = tempHome();
        touch(cacheFile(home, 'Library/Caches/rclone/bisync'));
        expect(leftoverRcloneFile(path.join(home, 'Proton'), home)).toContain('Library/Caches');
        const other = tempHome();
        const name = other.replace(/^\//, '').replace(/\//g, '_');
        touch(path.join(xdg, 'rclone/bisync', `${name}_Proton..proton_.path1.lst`));
        expect(leftoverRcloneFile(path.join(other, 'Proton'), other)).toBeUndefined();
        expect(leftoverRcloneFile(path.join(other, 'Proton'), other, { XDG_CACHE_HOME: xdg })).toContain(xdg);
    });
    test('a stopped and disabled systemd unit no longer blocks: this was the trap', () => {
        const home = tempHome();
        touch(path.join(home, '.config/systemd/user/rclone-bisync.timer'));
        touch(cacheFile(home));
        const check = checkTool(path.join(home, 'Proton'), home, { answer: 'yes', live: { 'systemctl --user is-enabled rclone-bisync.timer': 'disabled' } });
        expect(check.result).not.toThrow();
    });
    test('an active systemd unit blocks, whatever the folder, and says how to stop it', () => {
        const home = tempHome();
        touch(path.join(home, '.config/systemd/user/rclone-bisync.timer'));
        const check = checkTool(path.join(home, 'Proton'), home, { live: { 'systemctl --user is-active rclone-bisync.timer': 'active' } });
        expect(check.result).toThrow('systemctl --user disable --now rclone-bisync.timer');
    });
    test('a service in the middle of a bisync (activating) blocks', () => {
        const home = tempHome();
        touch(path.join(home, '.config/systemd/user/rclone-bisync.service'));
        const run: RunCommand = (_command, args) => (args[1] === 'is-active' ? { status: 3, stdout: 'activating\n' } : { status: 1, stdout: 'static\n' });
        expect(liveRcloneUnit(home, 501, run)).toContain('rclone-bisync.service');
    });
    test('an enabled systemd unit blocks even when it is not running', () => {
        const home = tempHome();
        touch(path.join(home, '.config/systemd/user/rclone-bisync.timer'));
        expect(liveRcloneUnit(home, 501, fakeRun({ 'systemctl --user is-enabled rclone-bisync.timer': 'enabled' }).run)).toContain('rclone-bisync.timer');
    });
    test('a static unit is neither active nor enabled', () => {
        const home = tempHome();
        touch(path.join(home, '.config/systemd/user/rclone-bisync.service'));
        expect(liveRcloneUnit(home, 501, fakeRun({ 'systemctl --user is-enabled rclone-bisync.service': 'static' }).run)).toBeUndefined();
    });
    test('a loaded launchd job blocks', () => {
        const home = tempHome();
        touch(path.join(home, 'Library/LaunchAgents/org.rclone.bisync.plist'));
        const message = liveRcloneUnit(home, 501, fakeRun({ 'launchctl print gui/501/org.rclone.bisync': 'state = running' }).run);
        expect(message).toContain('launchctl bootout gui/501/org.rclone.bisync');
    });
    test('a launchd job not loaded but set to start at login blocks', () => {
        const home = tempHome();
        touch(path.join(home, 'Library/LaunchAgents/org.rclone.bisync.plist'));
        const message = liveRcloneUnit(home, 501, fakeRun({ 'launchctl print-disabled gui/501': 'disabled services = {\n}' }).run);
        expect(message).toContain('launchctl disable gui/501/org.rclone.bisync');
    });
    test('a launchd job stopped and disabled no longer blocks', () => {
        const home = tempHome();
        touch(path.join(home, 'Library/LaunchAgents/org.rclone.bisync.plist'));
        expect(liveRcloneUnit(home, 501, fakeRun({ 'launchctl print-disabled gui/501': DISABLED_LIST }).run)).toBeUndefined();
    });
});

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
            ['systemctl', '--user', 'enable', '--now', 'nucleon-sync.service'],
        ]);
    });
    test('installing on macOS writes the plist then bootstraps it', () => {
        const home = tempHome();
        const calls: string[][] = [];
        installService('darwin', { ...o, home }, (cmd) => (calls.push(cmd), 0));
        const file = path.join(home, 'Library/LaunchAgents/org.nucleonsync.daemon.plist');
        expect(existsSync(file)).toBe(true);
        expect(existsSync(path.join(home, 'Library/Logs'))).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.slice(0, 2)).toEqual(['launchctl', 'bootstrap']);
        expect(calls[0]![3]).toBe(file);
    });
    test('a failing command is reported', () => {
        expect(() => installService('linux', { ...o, home: tempHome() }, () => 1)).toThrow('systemctl');
    });
    test('another system is refused with a clear error', () => {
        expect(() => installService('win32', o, () => 0)).toThrow('Linux and macOS');
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
