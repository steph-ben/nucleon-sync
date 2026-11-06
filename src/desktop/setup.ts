import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, realpathSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATABASE_FILES } from '../migrate';

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

const PLAN_WORDS: Record<string, string> = {
    link: 'already the same on both sides',
    upload: 'to upload',
    download: 'to download',
    remoteMkdir: 'folders to create on the Drive',
    localMkdir: 'folders to create here',
    remoteTrash: 'to move to the Proton trash',
    localQuarantine: 'to move from this folder to the quarantine',
};
/** Actions that remove something from one side: the first sync should not start on its own when there are any. */
export const REMOVING_ACTIONS = ['remoteTrash', 'localQuarantine'];

/** What the first sync would do, one row per kind of action. */
export function planRows(counts: Map<string, number>): { kind: string; text: string }[] {
    const rows = [...counts].map(([kind, n]) => ({ kind, text: `${String(n).padStart(6)}  ${PLAN_WORDS[kind] ?? kind}` }));
    return rows.length ? rows : [{ kind: 'none', text: '     0  nothing to do' }];
}

export function describePlan(counts: Map<string, number>): string[] {
    return planRows(counts).map((row) => row.text);
}

export interface Summary {
    folder: string;
    remote: string;
    home: string;
    dataDir: string;
    os: string;
    tray: string;
}

/** What was installed, what runs, and where the files are. Printed at the end of setup. */
export function finalSummary(s: Summary): string[] {
    const here = (p: string) => (p.startsWith(`${s.home}/`) ? `~/${p.slice(s.home.length + 1)}` : p);
    const target = s.remote === 'root' ? 'My files, on your Proton Drive' : s.remote;
    const service = s.os === 'darwin' ? '~/Library/LaunchAgents/org.nucleonsync.daemon.plist' : '~/.config/systemd/user/nucleon-sync.service';
    const stop = s.os === 'darwin' ? 'launchctl bootout gui/$(id -u)/org.nucleonsync.daemon' : 'systemctl --user stop nucleon-sync.service';
    return [
        'Your files',
        `  Synced folder   ${here(s.folder)}`,
        `  Synced with     ${target}`,
        `  Quarantine      ${here(path.join(s.dataDir, 'quarantine'))}   (what the sync replaces or removes here is kept there)`,
        '',
        'What was installed',
        `  Command         ~/.local/bin/nucleon-sync`,
        `  Program         ${here(path.join(s.dataDir, 'app'))}   (nucleon-sync and its own bun runtime)`,
        `  Data            ${here(s.dataDir)}   (configuration, database, log)`,
        '  Sign-in         your system keyring',
        '',
        'What is running',
        `  Service         nucleon-sync, running now, starts at every login (${service})`,
        `  Tray icon       ${s.tray}`,
        '',
        'Useful commands',
        '  nucleon-sync status      where things stand',
        '  nucleon-sync activity    what happened to your files',
        `  ${stop}`,
        '  nucleon-sync uninstall   removes the program, never the synced folder',
    ];
}

/** The real path, links resolved, also when the end of the path does not exist yet. */
function realPath(p: string): string {
    const parent = path.dirname(p);
    if (existsSync(p) || parent === p) return realpathSync(p);
    return path.join(realPath(parent), path.basename(p));
}

const isSameOrInside = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);

/** Why this folder cannot be synced, or undefined. The data folder holds the database and the quarantine: syncing it would feed the sync its own files. */
export function folderProblem(folder: string, home: string, data: string): string | undefined {
    const chosen = realPath(path.resolve(folder));
    const dataFolder = realPath(path.resolve(data));
    if (chosen === path.parse(chosen).root) return 'The root of the disk cannot be synced. Choose a folder of its own, such as ~/Proton.';
    if (chosen === realPath(path.resolve(home))) return 'Your home folder cannot be synced. Choose a folder of its own, such as ~/Proton.';
    if (isSameOrInside(chosen, dataFolder) || isSameOrInside(dataFolder, chosen)) return `${folder} overlaps the data folder ${data}. Choose a folder of its own, such as ~/Proton.`;
    return undefined;
}

/** A database without its config: it holds the memory of an unknown target, so setup must not reuse it. */
export function orphanDatabaseProblem(data: string, config: string): string | undefined {
    if (existsSync(config) || !existsSync(path.join(data, 'state.sqlite'))) return undefined;
    return `${path.join(data, 'state.sqlite')} exists without a configuration. Used with a new target it would quarantine your local files, so nothing was done. To start over, run: nucleon-sync setup --reset`;
}

/** Moves the config and the database into a dated folder of the data folder. Moves nothing else, deletes nothing. Returns that folder, if anything was moved. */
export function moveStateAside(data: string, config: string, now: Date): string | undefined {
    // The config first: a stop half way leaves a database without config, which setup refuses.
    const moves = [
        [config, 'config.json'],
        ...DATABASE_FILES.map((name) => [path.join(data, name), name]),
    ].filter(([from]) => existsSync(from!)) as [string, string][];
    if (!moves.length) return undefined;
    const name = `reset-${now.toISOString().slice(0, 19).replaceAll(':', '-')}`;
    let aside = path.join(data, name);
    for (let n = 2; existsSync(aside); n++) aside = path.join(data, `${name}-${n}`);
    mkdirSync(aside);
    for (const [from, to] of moves) renameSync(from, path.join(aside, to));
    return aside;
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
/** Enter alone takes the default; no answer at all (closed input) is always no. */
export function yesNo(answer: string | null | undefined, defaultYes: boolean): boolean {
    if (answer === null || answer === undefined) return false;
    if (answer.trim() === '') return defaultYes;
    return isYes(answer);
}

/** One line typed by the user: "" for a bare Enter, null when the input is closed before any answer. */
export function readAnswer(question: string): Promise<string | null> {
    return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        let answered = false;
        rl.question(`${question} `, (answer) => {
            answered = true;
            rl.close();
            resolve(answer);
        });
        rl.on('close', () => {
            if (!answered) resolve(null);
        });
    });
}

/**
 * Asks a yes/no question: Enter takes the default answer, a closed input is always no.
 * Not Bun's prompt(): it answers null on a bare Enter, the same as a closed input, so Enter did nothing.
 */
export async function askYesNo(question: string, defaultYes: boolean, ask: (question: string) => Promise<string | null> = readAnswer): Promise<boolean> {
    return yesNo(await ask(question), defaultYes);
}

export function isYes(answer: string | null | undefined): boolean {
    return /^y(es)?$/i.test((answer ?? '').trim());
}

/** Expands a leading ~ (alone or followed by /). */
export function expandHome(p: string, home: string): string {
    return p.replace(/^~(?=\/|$)/, home);
}
