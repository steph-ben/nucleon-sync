// Copy-only migration from proton-sync. This is the only source file that may name the old project.
// Nothing here removes, moves or overwrites anything: every write uses an exclusive flag or checks first.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_NAME, ROOT_MARKER } from './names';

const LEGACY_SECRET_SERVICE = 'proton-sync/session';
const NEW_SECRET_SERVICE = `${APP_NAME}/session`;
const SECRET_NAME = 'auth-session';
/** Copied in this order; config.json goes last because its presence means "migration done". */
const DATABASE_FILES = ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm'];

export interface MigrationPlan {
    legacyDir: string;
    newDir: string;
    steps: string[];
    blocked?: string;
}

export interface MigrationIo {
    readSecret(service: string, name: string): Promise<string | null>;
    writeSecret(service: string, name: string, value: string): Promise<void>;
}

/** Legacy data folders (any ~/.local/share/proton-sync* holding a config.json) and legacy service units. */
export function findLegacy(home: string): { dataDirs: string[]; services: string[] } {
    const share = path.join(home, '.local/share');
    const names = fs.existsSync(share) ? fs.readdirSync(share) : [];
    const dataDirs = names
        .filter((n) => n.startsWith('proton-sync') && fs.existsSync(path.join(share, n, 'config.json')))
        .sort()
        .map((n) => path.join(share, n));
    const services: string[] = [];
    if (fs.existsSync(path.join(home, '.config/systemd/user/proton-sync.service'))) services.push('proton-sync.service');
    if (fs.existsSync(path.join(home, 'Library/LaunchAgents/org.protonsync.daemon.plist'))) services.push('org.protonsync.daemon');
    return { dataDirs, services };
}

/** The exact two commands that stop then disable a legacy service. The user runs them by hand. */
export function stopCommands(service: string): string[] {
    if (service === 'proton-sync.service') return [`systemctl --user stop ${service}`, `systemctl --user disable ${service}`];
    return [`launchctl bootout gui/$(id -u)/${service}`, `launchctl disable gui/$(id -u)/${service}`];
}

/** True when daemon.lock in this data folder holds the pid of a live process. */
export function isDaemonRunning(dir: string): boolean {
    try {
        const pid = Number(fs.readFileSync(path.join(dir, 'daemon.lock'), 'utf8'));
        if (!pid) return false;
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function readLocalRoot(legacyDir: string): string | undefined {
    return JSON.parse(fs.readFileSync(path.join(legacyDir, 'config.json'), 'utf8')).localRoot;
}

function sameFile(a: string, b: string): boolean {
    return fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
}

export function planMigration(legacyDir: string, newDir: string, isRunning: (dir: string) => boolean): MigrationPlan {
    const plan: MigrationPlan = { legacyDir, newDir, steps: [] };
    if (!fs.existsSync(path.join(legacyDir, 'config.json'))) return { ...plan, blocked: `no config.json in ${legacyDir}` };
    if (isRunning(legacyDir)) return { ...plan, blocked: `stop the old daemon first (it is running from ${legacyDir})` };

    const newConfig = path.join(newDir, 'config.json');
    if (sameFile(path.join(legacyDir, 'config.json'), newConfig)) return plan; // already migrated: nothing to do
    const existing = ['config.json', ...DATABASE_FILES].filter((f) => fs.existsSync(path.join(newDir, f)));
    if (existing.length) return { ...plan, blocked: `${newDir} already exists and holds ${existing.join(', ')}: nothing will be overwritten` };

    for (const f of DATABASE_FILES) if (fs.existsSync(path.join(legacyDir, f))) plan.steps.push(`copy ${f} to ${newDir} (the database files are copied together)`);
    plan.steps.push(`copy the keychain entry ${LEGACY_SECRET_SERVICE} to ${NEW_SECRET_SERVICE} (only if the new one is empty)`);
    plan.steps.push(`add ${ROOT_MARKER} next to the old marker in ${readLocalRoot(legacyDir)}`);
    plan.steps.push(`copy config.json to ${newDir} (localRoot unchanged)`);
    return plan;
}

export async function applyMigration(plan: MigrationPlan, io: MigrationIo): Promise<void> {
    if (plan.blocked) throw new Error(plan.blocked);
    if (!plan.steps.length) return;
    const { legacyDir, newDir } = plan;
    fs.mkdirSync(newDir, { recursive: true });

    // COPYFILE_EXCL: fails instead of overwriting.
    for (const f of DATABASE_FILES) {
        if (fs.existsSync(path.join(legacyDir, f))) fs.copyFileSync(path.join(legacyDir, f), path.join(newDir, f), fs.constants.COPYFILE_EXCL);
    }

    const secret = await io.readSecret(LEGACY_SECRET_SERVICE, SECRET_NAME);
    if (secret !== null && (await io.readSecret(NEW_SECRET_SERVICE, SECRET_NAME)) === null) {
        await io.writeSecret(NEW_SECRET_SERVICE, SECRET_NAME, secret);
    }

    const localRoot = readLocalRoot(legacyDir);
    if (localRoot && fs.existsSync(localRoot)) fs.writeFileSync(path.join(localRoot, ROOT_MARKER), `${APP_NAME}\n`, { flag: 'a' });

    fs.copyFileSync(path.join(legacyDir, 'config.json'), path.join(newDir, 'config.json'), fs.constants.COPYFILE_EXCL);
}
