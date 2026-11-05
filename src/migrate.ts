// Copy-only migration from proton-sync. This is the only source file that may name the old project.
// Nothing here removes, moves or overwrites anything: every write uses an exclusive flag or checks first.
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { APP_NAME, LEGACY_ROOT_MARKER, ROOT_MARKER } from './names';

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
    /** Called right before the first copy: returns a reason to stop, if the legacy daemon came back. */
    recheck?(): string | undefined;
}

/** What the daemon checks run on: injected so tests need no systemd. */
export type RunCommand = (command: string, args: string[]) => { status: number | null; stdout: string };

export interface PlanOptions {
    /** Every legacy data folder found: a live daemon in any of them blocks. */
    otherDirs?: string[];
    /** Returns a description when a legacy service is active or enabled. */
    activeService?: () => string | undefined;
    /** The exact commands to print when blocked; default: those of every known legacy service. */
    commands?: string[];
}

const realRun: RunCommand = (command, args) => {
    const r = spawnSync(command, args, { encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '' };
};

/** Describes the first legacy service that is running or set to start by itself. */
export function activeLegacyService(home: string, uid: number, run: RunCommand = realRun): string | undefined {
    const found = findLegacy(home).services;
    for (const service of found) {
        if (service === 'proton-sync.service') {
            if (run('systemctl', ['--user', 'is-active', service]).status === 0) return `${service} is active`;
            if (run('systemctl', ['--user', 'is-enabled', service]).stdout.trim() === 'enabled') return `${service} is enabled`;
        } else {
            const label = `gui/${uid}/${service}`;
            if (run('launchctl', ['print', label]).status === 0) return `${service} is loaded`;
            if (!run('launchctl', ['print-disabled', `gui/${uid}`]).stdout.includes(`"${service}" => disabled`)) return `${service} is not disabled`;
        }
    }
    return undefined;
}

/** A live legacy daemon in a legacy data folder whose config syncs the same folder as the new one. */
export function legacyDaemonFor(home: string, localRoot: string, isRunning: (dir: string) => boolean = isDaemonRunning): string | undefined {
    return findLegacy(home).dataDirs.find((dir) => {
        try {
            return readLocalRoot(dir) === localRoot && isRunning(dir);
        } catch {
            return false;
        }
    });
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

function readLocalRoot(legacyDir: string): string {
    const config = JSON.parse(fs.readFileSync(path.join(legacyDir, 'config.json'), 'utf8'));
    if (typeof config?.localRoot !== 'string' || !config.localRoot) throw new Error('no localRoot');
    return config.localRoot;
}

function sameFile(a: string, b: string): boolean {
    return fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
}

const STAGING_DIR = '.migrating';

function markerProblem(localRoot: string): string | undefined {
    if (fs.existsSync(path.join(localRoot, LEGACY_ROOT_MARKER))) return undefined;
    return `${localRoot} does not hold ${LEGACY_ROOT_MARKER}: is the disk mounted? Nothing was copied`;
}

export function planMigration(legacyDir: string, newDir: string, isRunning: (dir: string) => boolean, options: PlanOptions = {}): MigrationPlan {
    const plan: MigrationPlan = { legacyDir, newDir, steps: [] };
    const block = (blocked: string) => ({ ...plan, blocked });
    if (!fs.existsSync(path.join(legacyDir, 'config.json'))) return block(`no config.json in ${legacyDir}`);
    let localRoot: string;
    try {
        localRoot = readLocalRoot(legacyDir);
    } catch {
        return block(`${path.join(legacyDir, 'config.json')} is not valid JSON or has no localRoot`);
    }
    if (path.resolve(legacyDir) === path.resolve(newDir)) return block(`the new data folder is the old one (${newDir}); is PROTON_SYNC_HOME or NUCLEON_SYNC_HOME exported?`);

    const running = [legacyDir, ...(options.otherDirs ?? [])].find((dir) => isRunning(dir));
    const service = options.activeService?.();
    if (running || service) {
        const what = running ? `a daemon is running from ${running}` : service;
        const commands = (options.commands ?? [...stopCommands('proton-sync.service'), ...stopCommands('org.protonsync.daemon')]).join(' ; ');
        return block(`stop the old daemon first (${what}). Run by hand: ${commands}`);
    }
    const problem = markerProblem(localRoot);
    if (problem) return block(problem);

    if (sameFile(path.join(legacyDir, 'config.json'), path.join(newDir, 'config.json'))) return plan; // already migrated
    const existing = ['config.json', ...DATABASE_FILES].filter((f) => fs.existsSync(path.join(newDir, f)));
    if (existing.includes('config.json')) return block(`${newDir} already exists and holds a different config.json: nothing will be overwritten`);
    if (existing.length) {
        return block(`a previous migration stopped half way: ${newDir} holds ${existing.join(', ')} but no config.json. The old folder is untouched. Move ${newDir} aside (mv ${newDir} ${newDir}.partial) and run migrate again`);
    }

    for (const f of DATABASE_FILES) if (fs.existsSync(path.join(legacyDir, f))) plan.steps.push(`copy ${f} to ${newDir} (the database files are copied together)`);
    plan.steps.push(`copy the login ${LEGACY_SECRET_SERVICE} to ${NEW_SECRET_SERVICE}, if there is one and the new one is empty`);
    plan.steps.push(`add ${ROOT_MARKER} next to the old marker in ${localRoot}`);
    plan.steps.push(`copy config.json to ${newDir} (localRoot unchanged)`);
    return plan;
}

/** Returns warnings to show the user. Throws, without having written anything in the old folder, if it cannot go on. */
export async function applyMigration(plan: MigrationPlan, io: MigrationIo): Promise<string[]> {
    if (plan.blocked) throw new Error(plan.blocked);
    if (!plan.steps.length) return [];
    const { legacyDir, newDir } = plan;
    const warnings: string[] = [];

    // Everything that can fail without side effects comes first.
    const secret = await io.readSecret(LEGACY_SECRET_SERVICE, SECRET_NAME);
    const newSecret = await io.readSecret(NEW_SECRET_SERVICE, SECRET_NAME);
    const localRoot = readLocalRoot(legacyDir);
    const problem = markerProblem(localRoot);
    if (problem) throw new Error(problem);
    const again = io.recheck?.();
    if (again) throw new Error(again);

    // Stage the database files in a temp folder, move them in only when all are complete.
    const staging = path.join(newDir, STAGING_DIR);
    fs.mkdirSync(newDir, { recursive: true });
    fs.rmSync(staging, { recursive: true, force: true }); // leftover of a previous run: ours, never the old folder's
    fs.mkdirSync(staging);
    const present = DATABASE_FILES.filter((f) => fs.existsSync(path.join(legacyDir, f)));
    for (const f of present) fs.copyFileSync(path.join(legacyDir, f), path.join(staging, f));

    if (secret === null) warnings.push('no saved login: run nucleon-sync login');
    else if (newSecret !== null) warnings.push('a login already exists for nucleon-sync: kept as it is');
    else await io.writeSecret(NEW_SECRET_SERVICE, SECRET_NAME, secret);

    fs.writeFileSync(path.join(localRoot, ROOT_MARKER), `${APP_NAME}\n`, { flag: 'a' });

    // COPYFILE_EXCL / rename onto a missing name: never overwrite. -wal and -shm first, the database last.
    for (const f of [...present].reverse()) {
        if (fs.existsSync(path.join(newDir, f))) throw new Error(`${path.join(newDir, f)} appeared: nothing overwritten`);
        fs.renameSync(path.join(staging, f), path.join(newDir, f));
    }
    fs.rmSync(staging, { recursive: true, force: true });
    fs.copyFileSync(path.join(legacyDir, 'config.json'), path.join(newDir, 'config.json'), fs.constants.COPYFILE_EXCL);
    return warnings;
}
