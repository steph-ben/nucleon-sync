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
    return text.replaceAll('__HOME__', o.home).replaceAll('__DATA__', o.dataDir).replaceAll('__COMMAND__', o.command);
}

function runChecked(run: (cmd: string[]) => number, cmd: string[]) {
    if (run(cmd) !== 0) throw new Error(`${cmd[0]} failed: ${cmd.join(' ')}`);
}

/** Writes the service file, then starts it now and at every login. */
export function installService(os: string, o: ServiceOptions, run: (cmd: string[]) => number): void {
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
    } else {
        throw new Error(`The service can only be installed on Linux and macOS, not on ${os}.`);
    }
}
