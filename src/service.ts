import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ServiceOptions {
    home: string;
    dataDir: string;
    /** The installed command, e.g. ~/.local/bin/nucleon-sync. */
    command: string;
    /** PROTON_DRIVE_CREDENTIALS_STORE of the user: the service must find the session in the same place. */
    credentialsStore?: string;
}

/**
 * The deploy/ folder sits next to the running program: one level up from src/ in a
 * checkout, next to the bundle in versions/<v>/nucleon-sync.js.
 */
export function findDeployDir(programDir: string): string {
    for (const candidate of [path.join(programDir, 'deploy'), path.join(programDir, '..', 'deploy')]) {
        if (existsSync(path.join(candidate, 'nucleon-sync.service'))) return path.resolve(candidate);
    }
    throw new Error(`deploy folder not found near ${programDir}`);
}

/** Text of the systemd unit (linux) or launchd plist (darwin), made from the template in deploy/. */
export function renderService(os: 'linux' | 'darwin', o: ServiceOptions): string {
    const template = os === 'linux' ? 'nucleon-sync.service' : 'org.nucleonsync.daemon.plist';
    const text = readFileSync(path.join(findDeployDir(import.meta.dir), template), 'utf8');
    // Values go inside quotes in the unit (% doubled, as systemd expands it) and inside XML text in the plist.
    const escape = os === 'linux' ? (v: string) => v.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') : xmlEscape;
    // The line of an unset value goes away: the template keeps it on one line for that.
    const lines = text.split('\n').filter((line) => o.credentialsStore || !line.includes('__CREDENTIALS_STORE__'));
    return lines.join('\n').replaceAll('__HOME__', escape(o.home)).replaceAll('__DATA__', escape(o.dataDir)).replaceAll('__COMMAND__', escape(o.command)).replaceAll('__CREDENTIALS_STORE__', escape(o.credentialsStore ?? ''));
}

function xmlEscape(v: string): string {
    return v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Why the service cannot be installed here (unsupported system, command missing), or undefined. */
export function serviceProblem(os: string, command?: string, exists: (file: string) => boolean = existsSync): string | undefined {
    if (os !== 'linux' && os !== 'darwin') return `The service can only be installed on Linux and macOS, not on ${os}.`;
    if (command && !exists(command)) return `The command ${command} does not exist, so the service would restart in a loop. Install nucleon-sync first, as the README explains.`;
    return undefined;
}

function runChecked(run: (cmd: string[]) => number, cmd: string[]) {
    if (run(cmd) !== 0) throw new Error(`${cmd[0]} failed: ${cmd.join(' ')}`);
}

/** Writes the service file, then starts it now and at every login. */
export function installService(os: string, o: ServiceOptions, run: (cmd: string[]) => number): void {
    const problem = serviceProblem(os);
    if (problem) throw new Error(problem);
    if (os === 'linux') {
        const file = path.join(o.home, '.config/systemd/user/nucleon-sync.service');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, renderService('linux', o));
        runChecked(run, ['systemctl', '--user', 'daemon-reload']);
        runChecked(run, ['systemctl', '--user', 'enable', 'nucleon-sync.service']);
        // Not "enable --now": a service already running must pick up the new unit.
        runChecked(run, ['systemctl', '--user', 'restart', 'nucleon-sync.service']);
    } else if (os === 'darwin') {
        const file = path.join(o.home, 'Library/LaunchAgents/org.nucleonsync.daemon.plist');
        mkdirSync(path.dirname(file), { recursive: true });
        mkdirSync(path.join(o.home, 'Library/Logs'), { recursive: true });
        writeFileSync(file, renderService('darwin', o));
        const domain = `gui/${process.getuid?.() ?? 501}`;
        // On a rerun bootstrap fails while the old job is loaded. No job loaded is fine.
        run(['launchctl', 'bootout', `${domain}/org.nucleonsync.daemon`]);
        runChecked(run, ['launchctl', 'bootstrap', domain, file]);
    }
}

/** launchctl print also succeeds for a job that crashes in a loop: only a running state and a pid prove it is up. */
export function launchdJobRunning(printed: string): boolean {
    return /^\s*state = running$/m.test(printed) && /^\s*pid = \d+$/m.test(printed);
}

/** True when the service runs now. `output` gives the standard output of a command, empty if it failed. */
export function serviceIsUp(os: string, uid: number, output: (cmd: string[]) => string): boolean {
    if (os === 'darwin') return launchdJobRunning(output(['launchctl', 'print', `gui/${uid}/org.nucleonsync.daemon`]));
    return output(['systemctl', '--user', 'is-active', 'nucleon-sync.service']).trim() === 'active';
}
