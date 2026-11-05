import { readdirSync } from 'node:fs';
import path from 'node:path';

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

/** A sentence naming another sync tool already set up for this folder, or undefined. */
export function otherSyncToolFor(folder: string, home: string): string | undefined {
    // rclone names its bisync state after the folder path with "/" replaced by "_", joined with the remote path.
    const flat = path.resolve(folder).replace(/^\//, '').replace(/\//g, '_');
    const states = namesIn(path.join(home, '.cache/rclone/bisync'));
    if (states.some((n) => n.includes(flat))) return `rclone bisync already syncs ${folder} (state in ~/.cache/rclone/bisync). Stop it first, two tools on one folder lose files.`;
    if (namesIn(path.join(home, '.config/systemd/user')).some((n) => n.startsWith('rclone-bisync'))) return 'An rclone-bisync systemd unit is installed. Disable it first, two tools on one folder lose files.';
    if (namesIn(path.join(home, 'Library/LaunchAgents')).some((n) => n.startsWith('org.rclone'))) return 'An rclone launchd agent is installed. Unload it first, two tools on one folder lose files.';
    return undefined;
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
