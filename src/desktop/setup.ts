import { readdirSync } from 'node:fs';
import path from 'node:path';
import { isDisabledInLaunchctl, type RunCommand } from '../migrate';

export interface SetupAnswers {
    folder: string;
    target: 'test' | 'myfiles';
    /** The user typed the confirmation for their real data. */
    confirmed: boolean;
    deviceName: string;
}

export function buildConfig(a: SetupAnswers): { localRoot: string; remote: string; deviceName: string; maxDeletes: number; allowDriveRoot?: boolean } {
    if (a.target === 'myfiles' && !a.confirmed) throw new Error('My files needs an explicit confirmation');
    const common = { localRoot: a.folder, deviceName: a.deviceName, maxDeletes: 20 };
    return a.target === 'myfiles' ? { ...common, remote: 'root', allowDriveRoot: true } : { ...common, remote: `device:nucleon-sync-test/sandbox-${a.deviceName}` };
}

/** A sentence saying which rclone unit of this user runs or starts by itself, or undefined. Unit names say nothing about the folder, so any of them blocks. */
export function liveRcloneUnit(home: string, uid: number, run: RunCommand): string | undefined {
    const units = namesIn(path.join(home, '.config/systemd/user')).filter((n) => n.startsWith('rclone-bisync'));
    for (const unit of units) {
        const active = run('systemctl', ['--user', 'is-active', unit]).stdout.trim();
        const enabled = run('systemctl', ['--user', 'is-enabled', unit]).stdout.trim();
        if (active === 'active' || active === 'activating' || enabled === 'enabled') {
            return `The rclone unit ${unit} is ${enabled === 'enabled' ? 'enabled' : 'running'}. Stop it first: systemctl --user disable --now ${unit}. Two tools on one Drive lose files.`;
        }
    }
    const plists = namesIn(path.join(home, 'Library/LaunchAgents')).filter((n) => n.startsWith('org.rclone') && n.endsWith('.plist'));
    for (const label of plists.map((n) => n.slice(0, -'.plist'.length))) {
        const service = `gui/${uid}/${label}`;
        if (run('launchctl', ['print', service]).status === 0) return `The rclone job ${label} is loaded. Stop it first: launchctl bootout ${service}, then launchctl disable ${service}. Two tools on one Drive lose files.`;
        // Not loaded, but launchd starts it again at the next login unless it is disabled.
        if (!isDisabledInLaunchctl(run('launchctl', ['print-disabled', `gui/${uid}`]).stdout, label)) {
            return `The rclone job ${label} starts at login. Run launchctl disable ${service}, or remove ~/Library/LaunchAgents/${label}.plist. Two tools on one Drive lose files.`;
        }
    }
    return undefined;
}

/** A file left by rclone bisync for this folder, or undefined. It proves rclone ran once, not that it still runs. */
export function leftoverRcloneFile(folder: string, home: string, env: Record<string, string | undefined> = {}): string | undefined {
    // rclone names its bisync state after the folder path with "/" replaced by "_", joined with the remote path.
    const flat = path.resolve(folder).replace(/^\//, '').replace(/\//g, '_');
    const cacheDirs = [path.join(home, '.cache/rclone/bisync'), path.join(home, 'Library/Caches/rclone/bisync')];
    if (env.XDG_CACHE_HOME) cacheDirs.push(path.join(env.XDG_CACHE_HOME, 'rclone/bisync'));
    for (const dir of cacheDirs) {
        const name = namesIn(dir).find((n) => n.includes(flat));
        if (name) return path.join(dir, name);
    }
    return undefined;
}

export interface SyncToolCheck {
    home: string;
    uid: number;
    run: RunCommand;
    env: Record<string, string | undefined>;
    print: (line: string) => void;
    ask: (question: string) => string | null;
}

/** Throws when rclone is live. A leftover file alone only warns, and goes on after a typed yes. */
export function checkOtherSyncTool(folder: string, d: SyncToolCheck): void {
    const live = liveRcloneUnit(d.home, d.uid, d.run);
    if (live) throw new Error(live);
    const leftover = leftoverRcloneFile(folder, d.home, d.env);
    if (!leftover) return;
    d.print(`Warning: rclone bisync used ${folder} in the past. It left this file, and no rclone service is running or enabled now:`);
    d.print(`  ${leftover}`);
    d.print('If rclone still runs some other way (cron, a script, another machine), stop it first. Two tools on one Drive lose files.');
    if (d.ask('Type yes if rclone is stopped everywhere') !== 'yes') throw new Error('rclone not confirmed as stopped, nothing was done.');
}

function namesIn(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/** Tries to write and delete a test secret. Returns how to fix it when that fails. */
export async function sessionStoreProblem(probe: () => Promise<void>): Promise<string | undefined> {
    try {
        await probe();
        return undefined;
    } catch (e) {
        return `The password store is not usable (${(e as Error).message}). Either install libsecret and a running secret service (GNOME Keyring or KWallet), or use pass: export PROTON_DRIVE_CREDENTIALS_STORE=pass`;
    }
}

/** "y" or "yes", any case. Anything else is a no. */
export function isYes(answer: string | null | undefined): boolean {
    return /^y(es)?$/i.test((answer ?? '').trim());
}

/** Expands a leading ~ (alone or followed by /). */
export function expandHome(p: string, home: string): string {
    return p.replace(/^~(?=\/|$)/, home);
}
