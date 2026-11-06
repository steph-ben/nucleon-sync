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

const realSleep = (ms: number) => Bun.sleepSync(ms);

/**
 * Loads a launchd agent, replacing the one that is loaded. "launchctl bootout" returns before launchd has finished unloading
 * the job, and a bootstrap in that window fails with "Input/output error": the old job is gone and the new one never loads.
 * So this waits until the job is really gone, then tries the bootstrap again a few times. True when it is loaded.
 */
export function loadAgent(run: (cmd: string[]) => number, domain: string, label: string, file: string, sleep: (ms: number) => void = realSleep): boolean {
    const target = `${domain}/${label}`;
    run(['launchctl', 'bootout', target]);
    for (let i = 0; i < 100 && run(['launchctl', 'print', target]) === 0; i++) sleep(100);
    for (let i = 0; i < 10; i++) {
        if (run(['launchctl', 'bootstrap', domain, file]) === 0) return true;
        sleep(500);
    }
    return false;
}

/** Writes the service file, then starts it now and at every login. */
export function installService(os: string, o: ServiceOptions, run: (cmd: string[]) => number, sleep: (ms: number) => void = realSleep): void {
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
        // On a rerun the old job is replaced. No job loaded is fine.
        if (!loadAgent(run, domain, 'org.nucleonsync.daemon', file, sleep)) throw new Error(`launchctl failed: launchctl bootstrap ${domain} ${file}`);
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

export const TRAY_NAMESPACES = ['AyatanaAppIndicator3', 'AppIndicator3'];

export interface TrayChecks {
    hasIndicatorLibrary: () => boolean;
    /** GNOME without the AppIndicator extension hides every tray icon. */
    gnomeNeedsExtension: () => boolean;
    /** A rerun must not leave two icons, and an update must load the new script. */
    stopRunning: () => void;
    start: (cmd: string[]) => void;
}

/** Starts the tray icon now and at every login, or says what is missing. Returns a line for the summary. Never installs system packages. */
export function installTray(o: Pick<ServiceOptions, 'home' | 'dataDir' | 'command'>, checks: TrayChecks): string {
    if (!checks.hasIndicatorLibrary()) return 'not started: it needs libayatana-appindicator-gtk3 (or libappindicator-gtk3) and python3-gobject';
    // Through "current", so an update keeps the icon working.
    const root = path.join(o.home, '.local/share/nucleon-sync/app/current');
    const script = path.join(root, 'desktop/linux/nucleon-sync-tray.py');
    if (!existsSync(script)) return `not started: ${script} is missing`;
    const entry = readFileSync(path.join(findDeployDir(import.meta.dir), 'nucleon-sync-tray.desktop'), 'utf8');
    const file = path.join(o.home, '.config/autostart/nucleon-sync-tray.desktop');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, entry.replaceAll('__ROOT__', root).replaceAll('__HOME__', o.home).replaceAll('__DATA__', o.dataDir));
    checks.stopRunning();
    checks.start(['python3', script, o.command, o.dataDir]);
    if (checks.gnomeNeedsExtension()) return 'started, but GNOME hides it until you enable the AppIndicator extension (gnome-shell-extension-appindicator)';
    return 'started, and starts at every login';
}

const MAC_TRAY_LABEL = 'org.nucleonsync.tray';

/**
 * Builds the menu bar icon with the Swift compiler of the Mac (one file, no download), then loads it as a login agent.
 * Returns a line for the summary. Never installs the command line tools: it says how.
 */
export function installMacTray(o: Pick<ServiceOptions, 'home' | 'dataDir' | 'command'>, run: (cmd: string[]) => number, uid: number = process.getuid?.() ?? 501, sleep: (ms: number) => void = realSleep): string {
    // Through "current", so an update brings the new source.
    const source = path.join(o.home, '.local/share/nucleon-sync/app/current/desktop/macos/NucleonSyncTray.swift');
    if (!existsSync(source)) return `not started: ${source} is missing`;
    const binary = path.join(o.home, '.local/bin/nucleon-sync-tray');
    mkdirSync(path.dirname(binary), { recursive: true });
    if (run(['swiftc', '-O', source, '-o', binary]) !== 0) return 'not started: it needs the Apple command line tools to build (run: xcode-select --install, then nucleon-sync setup)';
    const template = readFileSync(path.join(findDeployDir(import.meta.dir), `${MAC_TRAY_LABEL}.plist`), 'utf8');
    const file = path.join(o.home, `Library/LaunchAgents/${MAC_TRAY_LABEL}.plist`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, template.replaceAll('__HOME__', xmlEscape(o.home)).replaceAll('__DATA__', xmlEscape(o.dataDir)));
    // A rerun or an update must load the new build, and never leave two icons.
    if (!loadAgent(run, `gui/${uid}`, MAC_TRAY_LABEL, file, sleep)) return `not started: launchctl could not load ${file}`;
    return 'started, and starts at every login';
}
