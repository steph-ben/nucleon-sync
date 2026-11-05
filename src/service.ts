import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ServiceOptions {
    home: string;
    dataDir: string;
    /** The installed command, e.g. ~/.local/bin/nucleon-sync. */
    command: string;
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
    return text.replaceAll('__HOME__', escape(o.home)).replaceAll('__DATA__', escape(o.dataDir)).replaceAll('__COMMAND__', escape(o.command));
}

function xmlEscape(v: string): string {
    return v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Why the service cannot be installed here (unsupported system, command missing), or undefined. */
export function serviceProblem(os: string, command?: string, exists: (file: string) => boolean = existsSync): string | undefined {
    if (os !== 'linux' && os !== 'darwin') return `The service can only be installed on Linux and macOS, not on ${os}.`;
    if (command && !exists(command)) return `The command ${command} does not exist, so the service would restart in a loop. Install nucleon-sync there first (scripts/install.sh).`;
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
        runChecked(run, ['systemctl', '--user', 'enable', '--now', 'nucleon-sync.service']);
    } else if (os === 'darwin') {
        const file = path.join(o.home, 'Library/LaunchAgents/org.nucleonsync.daemon.plist');
        mkdirSync(path.dirname(file), { recursive: true });
        mkdirSync(path.join(o.home, 'Library/Logs'), { recursive: true });
        writeFileSync(file, renderService('darwin', o));
        runChecked(run, ['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, file]);
    }
}
