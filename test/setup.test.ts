import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildConfig, otherSyncToolFor, sessionStoreProblem } from '../src/desktop/setup';
import { findDeployDir, installService, renderService } from '../src/service';

function tempHome(): string {
    return mkdtempSync(path.join(tmpdir(), 'setup-home-'));
}

function touch(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
}

describe('other sync tool', () => {
    test('rclone state for the folder is detected', () => {
        const home = tempHome();
        const name = home.replace(/^\//, '').replace(/\//g, '_');
        touch(path.join(home, '.cache/rclone/bisync', `${name}_Proton..proton_.path1.lst`));
        expect(otherSyncToolFor(path.join(home, 'Proton'), home)).toContain('rclone');
    });
    test('rclone state with the folder in the middle of the name is detected', () => {
        const home = tempHome();
        const name = home.replace(/^\//, '').replace(/\//g, '_');
        touch(path.join(home, '.cache/rclone/bisync', `proton_${name}_Proton.path2.lst`));
        expect(otherSyncToolFor(path.join(home, 'Proton'), home)).toContain('rclone');
    });
    test('an unrelated folder is not flagged', () => {
        const home = tempHome();
        const name = home.replace(/^\//, '').replace(/\//g, '_');
        touch(path.join(home, '.cache/rclone/bisync', `${name}_Proton..proton_.path1.lst`));
        expect(otherSyncToolFor(path.join(home, 'Other'), home)).toBeUndefined();
    });
    test('nothing installed gives undefined', () => {
        const home = tempHome();
        expect(otherSyncToolFor(path.join(home, 'Proton'), home)).toBeUndefined();
    });
    test('an rclone-bisync user unit is detected', () => {
        const home = tempHome();
        touch(path.join(home, '.config/systemd/user/rclone-bisync-proton.service'));
        expect(otherSyncToolFor(path.join(home, 'Proton'), home)).toContain('rclone');
    });
    test('an org.rclone launchd plist is detected', () => {
        const home = tempHome();
        touch(path.join(home, 'Library/LaunchAgents/org.rclone.bisync.plist'));
        expect(otherSyncToolFor(path.join(home, 'Proton'), home)).toContain('rclone');
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
        expect(unit).toContain('ExecStart=/home/u/.local/bin/nucleon-sync run');
        expect(unit).toContain('Environment=NUCLEON_SYNC_HOME=/home/u/.local/share/nucleon-sync');
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
        expect(readFileSync(file, 'utf8')).toContain(`Environment=PATH=${home}/.local/bin`);
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
