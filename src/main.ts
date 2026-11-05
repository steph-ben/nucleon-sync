#!/usr/bin/env bun
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, writeSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import path from 'node:path';

import { createRootMarker, defaultIgnore, detectCaseInsensitive, RealLocalFs } from './adapters/local';
import { ProtonRemote } from './adapters/proton';
import { SqliteStore } from './adapters/sqlite-store';
import { Engine, SafetyStop } from './core/engine';
import type { Logger, Plan } from './core/types';
import { recentActivity } from './desktop/activity';
import { makeIgnore } from './desktop/exclude';
import { isOutdatedClient, retryDelaySeconds, signIn } from './desktop/signin';
import { sendNote } from './desktop/notify';
import { buildConfig, expandHome, isYes, otherSyncToolFor, sessionStoreProblem } from './desktop/setup';
import { installService, serviceProblem } from './service';
import type { View } from './desktop/state';
import { DesktopTracker, UNSEEN_KEY } from './desktop/tracker';
import { checkForUpdate } from './desktop/update';
import { activeLegacyService, applyMigration, findLegacy, isDaemonRunning, knownStopCommands, legacyDaemonFor, planMigration, stopCommands } from './migrate';
import { APP_NAME, APP_VERSION, configFile, dataDir, THIRD_PARTY_NOTICE } from './names';
import { ChangeTracker } from './watch';

const DATA = dataDir(process.env, homedir());
const POLL_SECONDS = 60;
const DEBOUNCE_MS = 3000;
const HEARTBEAT_MS = 60 * 60 * 1000;
/** The icons read this file: older than DAEMON_GONE_MS means nobody is syncing. */
const STATE_REFRESH_MS = 30 * 1000;
const DAEMON_GONE_MS = 3 * 60 * 1000;
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = path.join(DATA, 'desktop.json');
const PAUSE_FILE = path.join(DATA, 'paused');

interface Config {
    localRoot: string;
    /**
     * `device:<name>/<folder>` for an isolated space, `root` for My files. The subfolder is
     * needed for testing: Proton forbids files at the root of a device, and renaming its
     * top-level folders from any client other than its desktop app.
     */
    remote: string;
    deviceName: string;
    maxDeletes: number;
    /** Must be true to sync My files: protects against running a test on the real Drive. */
    allowDriveRoot?: boolean;
    /** Name patterns never synced, on top of the built-in ones. */
    exclude?: string[];
    /** Detailed log: watcher events, wake-up causes, duration of each pass. */
    verbose?: boolean;
}

function configPath() {
    return configFile(process.env, DATA);
}

function loadConfig(): Config {
    const file = configPath();
    if (!existsSync(file)) throw new Error(`configuration missing: ${file}. Run: nucleon-sync init <folder> <device:name/folder|root>`);
    return JSON.parse(readFileSync(file, 'utf8')) as Config;
}

/** One line per event: "<ISO time> <LEVEL> <message>". DEBUG lines only when `verbose` is on. */
function saveConfig(cfg: Config) {
    const file = configPath();
    writeFileSync(`${file}.tmp`, `${JSON.stringify(cfg, null, 4)}\n`);
    renameSync(`${file}.tmp`, file);
}

function daemonPid(): number | undefined {
    try {
        return Number(readFileSync(path.join(DATA, 'daemon.lock'), 'utf8')) || undefined;
    } catch {
        return undefined;
    }
}

/** Wakes the daemon, or with SIGTERM lets its service restart it with a new configuration. */
function signalDaemon(signal: 'SIGUSR1' | 'SIGTERM') {
    const pid = daemonPid();
    if (!pid) return;
    try {
        process.kill(pid, signal);
    } catch {
        /* the daemon is not running */
    }
}

function logger(verbose = false): Logger {
    mkdirSync(DATA, { recursive: true });
    const file = path.join(DATA, 'nucleon-sync.log');
    return (level, message) => {
        if (level === 'DEBUG' && !verbose) return;
        const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
        appendFileSync(file, `${line}\n`);
        if (process.stdout.isTTY) console.log(line);
    };
}

/** Writes and deletes a test secret, unless the user chose another store (pass or file). */
async function probeSessionStore(): Promise<void> {
    if (process.env.PROTON_DRIVE_CREDENTIALS_STORE && process.env.PROTON_DRIVE_CREDENTIALS_STORE !== 'keychain') return;
    const secret = { service: 'nucleon-sync-setup-test', name: 'probe' };
    await Bun.secrets.set({ ...secret, value: 'test' });
    await Bun.secrets.delete(secret);
}

/** Last step of setup: ask, then install the service. A failure here leaves the configuration and sign-in intact. */
function startSyncing(command: string) {
    if (!isYes(prompt('Start syncing now? [y/N]'))) {
        console.log('Nothing was changed. Review it, then run nucleon-sync once, or run nucleon-sync setup again.');
        return;
    }
    const problem = serviceProblem(platform(), command);
    try {
        if (problem) throw new Error(problem);
        installService(platform(), { home: homedir(), dataDir: DATA, command }, (cmd) => Bun.spawnSync(cmd).exitCode);
    } catch (e) {
        console.log(`The service could not be installed: ${(e as Error).message}`);
        console.log('Your configuration and sign-in are fine. To start syncing by hand: nucleon-sync run');
        return;
    }
    console.log(`Syncing started. Log: ${path.join(DATA, 'nucleon-sync.log')}`);
}

async function sdkContext() {
    process.env.PROTON_DRIVE_CACHE_DIR ??= path.join(DATA, 'sdk');
    process.env.PROTON_DRIVE_LOG_LEVEL ??= 'WARNING';
    const { init } = await import('../vendor/proton-sdk/cli/src/init');
    return init({ appVersion: APP_VERSION, clientUidPrefix: 'external-drive-nucleon_sync', enablePersistedEvents: false, enableMetrics: false, flags: {} });
}

type Ctx = Awaited<ReturnType<typeof sdkContext>>;

async function resolveRoot(ctx: Ctx, cfg: Config) {
    if (cfg.remote === 'root') {
        if (!cfg.allowDriveRoot) throw new Error('syncing My files requires "allowDriveRoot": true in the configuration');
        const root = await ctx.sdk.getMyFilesRootFolder();
        return { rootUid: root.uid, scopeId: root.treeEventScopeId };
    }
    const m = /^device:([^/]+)(?:\/([^/]+))?$/.exec(cfg.remote);
    if (!m) throw new Error(`invalid remote target: ${cfg.remote}`);
    let device;
    for await (const d of ctx.sdk.iterateDevices()) if (d.name.ok && d.name.value === m[1]) device = d;
    if (!device) {
        const { DeviceType } = await import('@protontech/drive-sdk');
        device = await ctx.sdk.createDevice(m[1]!, platform() === 'darwin' ? DeviceType.MacOS : DeviceType.Linux);
    }
    let root = await ctx.sdk.getNode(device.rootFolderUid);
    if (m[2]) {
        let sub;
        for await (const c of ctx.sdk.iterateFolderChildren(root.uid)) if (c.name.ok && c.name.value === m[2]) sub = c;
        root = sub ?? (await ctx.sdk.createFolder(root.uid, m[2]));
    }
    return { rootUid: root.uid, scopeId: root.treeEventScopeId };
}

async function buildEngine(cfg: Config, ctx: Ctx, log: Logger, touched?: (paths: string[]) => void, progress?: (done: number, total: number, line: string) => void) {
    mkdirSync(DATA, { recursive: true });
    const store = new SqliteStore(path.join(DATA, 'state.sqlite'));
    const quarantine = path.join(DATA, 'quarantine');
    const ignore = makeIgnore(cfg.exclude ?? []);
    const local = new RealLocalFs(cfg.localRoot, quarantine, { ignore });
    await local.assertRootSafe();
    const { rootUid, scopeId } = await resolveRoot(ctx, cfg);
    const remote = new ProtonRemote(ctx.sdk, rootUid, scopeId, store, log, (p) => local.absolutePath(p), ignore);
    const engine = new Engine(local, remote, store, {
        deviceName: cfg.deviceName,
        caseInsensitive: await detectCaseInsensitive(cfg.localRoot),
        maxDeletes: cfg.maxDeletes,
        newKey: () => crypto.randomUUID(),
        today: () => new Date().toISOString().slice(0, 10),
        log,
        touched,
        progress,
    });
    return { engine, store };
}

function summarize(plan: Plan) {
    const counts = new Map<string, number>();
    for (const a of plan.actions) counts.set(a.t, (counts.get(a.t) ?? 0) + 1);
    return [...counts].map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing to do';
}

function acquireLock(localRoot: string) {
    const legacy = legacyDaemonFor(homedir(), localRoot);
    if (legacy) throw new Error(`the old daemon is still running (${legacy}). Stop it first, two daemons on one folder can lose files`);
    const file = path.join(DATA, 'daemon.lock');
    mkdirSync(DATA, { recursive: true });
    if (existsSync(file)) {
        const pid = Number(readFileSync(file, 'utf8'));
        try {
            process.kill(pid, 0);
            throw new Error(`already running (pid ${pid})`);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        }
    }
    const fd = openSync(file, 'w');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    process.on('exit', () => {
        try {
            unlinkSync(file);
        } catch {
            /* nothing to do */
        }
    });
}

async function daemon(cfg: Config) {
    const verbose = cfg.verbose ?? false;
    const log = logger(verbose);
    acquireLock(cfg.localRoot);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
            log('INFO', `daemon stopping (${signal})`);
            process.exit(0);
        });
    }
    const ctx = await sdkContext();
    if (!ctx.auth.isLoggedIn()) throw new Error('not logged in: run nucleon-sync login');
    const tracker = new ChangeTracker(makeIgnore(cfg.exclude ?? []));
    let desktop: DesktopTracker | undefined;
    const { engine, store } = await buildEngine(cfg, ctx, log, (paths) => tracker.own(paths, Date.now()), (done, total, line) => desktop?.progress(done, total, line));
    desktop = new DesktopTracker(STATE_FILE, process.pid, store, sendNote, Date.now, () => existsSync(PAUSE_FILE));
    const view = desktop;
    view.flush();
    setInterval(() => view.flush(), STATE_REFRESH_MS);
    setInterval(() => {
        // In its own process: installing restarts this daemon.
        Bun.spawn([process.execPath, process.argv[1]!, 'update'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).unref();
    }, UPDATE_EVERY_MS);

    let wake: (() => void) | undefined;
    process.on('SIGUSR1', () => {
        view.flush();
        cause = 'command';
        wake?.();
    });
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let cause = 'startup';
    const trigger = () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            log('DEBUG', `watcher: quiet for ${DEBOUNCE_MS} ms${running ? ', but a pass is running (it will start another one when it ends)' : ', waking the loop'}`);
            wake?.();
        }, DEBOUNCE_MS);
    };
    // The scan stays the reference: the watcher only makes the daemon react quickly.
    watch(cfg.localRoot, { recursive: true }, (event, name) => {
        if (!name) return;
        const origin = tracker.classify(String(name), Date.now());
        // Noise and echoes of the daemon's own writes: nothing worth a line.
        if (origin !== 'local') return;
        log('DEBUG', `watcher: local change: ${event} ${name}${running ? ' (during a pass)' : ''}`);
        trigger();
    });

    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    const some = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3} more` : names.join(', '));
    log('INFO', `daemon started: version=${APP_VERSION} pid=${process.pid} root=${cfg.localRoot} target=${cfg.remote} device=${cfg.deviceName} maxDeletes=${cfg.maxDeletes} poll=${POLL_SECONDS} s verbose=${verbose}`);

    let failures = 0;
    let outdated = false;
    let pass = 0;
    let lastHeld = -1;
    let lastWarnings = new Set<string>();
    let beat = { at: Date.now(), passes: 0, withErrors: 0 };
    for (;;) {
        if (existsSync(PAUSE_FILE)) {
            log('INFO', 'paused: no pass until resume');
            view.flush();
            while (existsSync(PAUSE_FILE)) {
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
            log('INFO', 'resumed');
        }
        let delay = POLL_SECONDS * 1000;
        const started = Date.now();
        const local = tracker.drain();
        pass++;
        beat.passes++;
        running = true;
        log('INFO', `pass ${pass} start: ${cause}${local.length ? `; local changes: ${some(local)}` : ''}`);
        try {
            view.passStart();
            const approve = store.getKv('approve-deletes') === '1';
            const r = await engine.cycle(approve);
            if (approve) store.setKv('approve-deletes', '0');
            view.passDone(r);
            store.setKv('status', JSON.stringify({ at: new Date().toISOString(), summary: summarize(r.plan), held: r.plan.held.length, warnings: r.plan.warnings, errors: r.errors }));
            const took = seconds(Date.now() - started);
            if (r.plan.actions.length || r.errors.length) log('INFO', `pass ${pass} done in ${took}: done=${r.done} skipped=${r.skipped} errors=${r.errors.length}`);
            else log('DEBUG', `pass ${pass} done in ${took}: nothing to do`);
            // Warn once per new problem, not every minute.
            for (const w of r.plan.warnings) if (!lastWarnings.has(w)) log('WARN', w);
            lastWarnings = new Set(r.plan.warnings);
            if (r.plan.held.length !== lastHeld) {
                if (r.plan.heldReason === 'incomplete-scan') log('WARN', `${r.plan.held.length} deletions postponed until every file can be read again`);
                else if (r.plan.held.length) log('WARN', `${r.plan.held.length} deletions held (limit ${cfg.maxDeletes}): review with 'nucleon-sync plan', then run 'nucleon-sync approve'`);
                lastHeld = r.plan.held.length;
            }
            if (r.errors.length) beat.withErrors++;
            failures = r.errors.length ? failures + 1 : 0;
            outdated = false;
            // Work was done: run again soon to confirm the state is stable.
            if (r.plan.actions.length) delay = 2000;
        } catch (e) {
            failures++;
            beat.withErrors++;
            const safety = e instanceof SafetyStop;
            view.passFailed(e, safety);
            const message = e instanceof Error ? e.message : String(e);
            if (isOutdatedClient(message)) {
                if (!outdated) log('ERROR', `Proton no longer accepts this version: run nucleon-sync update. Checking again every hour. (${message})`);
                outdated = true;
            } else {
                outdated = false;
                log('ERROR', `${safety ? 'safety stop (no file was touched)' : `pass ${pass} failed`}: ${message}`);
            }
            store.setKv('status', JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
        } finally {
            running = false;
        }
        if (failures) {
            delay = retryDelaySeconds(failures, outdated, POLL_SECONDS) * 1000;
            if (!outdated) log('WARN', `retrying in ${Math.round(delay / 1000)} s (consecutive failed passes: ${failures})`);
        } else if (tracker.hasPending()) {
            // The user changed something while the pass was running: do not wait for the next poll.
            delay = DEBOUNCE_MS;
        }
        if (Date.now() - beat.at >= HEARTBEAT_MS) {
            log('INFO', `alive: ${beat.passes} passes in the last hour, ${beat.withErrors} with errors`);
            beat = { at: Date.now(), passes: 0, withErrors: 0 };
        }
        const reason = failures ? 'retry after an error' : delay === 2000 ? 'follow-up check after work' : 'Drive poll';
        await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
                cause = reason;
                resolve();
            }, delay);
            wake = () => {
                cause = 'local change';
                clearTimeout(t);
                resolve();
            };
        });
    }
}

function printPlan(plan: Plan) {
    console.log(`summary: ${summarize(plan)}`);
    for (const a of plan.actions) console.log(JSON.stringify(a));
    if (plan.held.length) console.log(`held (${plan.held.length}):`);
    for (const a of plan.held) console.log(JSON.stringify(a));
    for (const w of plan.warnings) console.log(`warning: ${w}`);
}

/** Copies the config, database and login of the old project into this one. Copy only. */
async function migrate(args: string[]) {
    const fromIndex = args.indexOf('--from');
    if (fromIndex >= 0 && !args[fromIndex + 1]) throw new Error('usage: nucleon-sync migrate [--from <old data folder>]');
    const found = findLegacy(homedir());
    let legacyDir = fromIndex >= 0 ? path.resolve(args[fromIndex + 1]!) : undefined;
    if (!legacyDir) {
        if (!found.dataDirs.length) throw new Error('no old data folder found. Use: nucleon-sync migrate --from <folder>');
        console.log('Old data folders found:');
        found.dataDirs.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
        const answer = found.dataDirs.length === 1 ? '1' : prompt('Which one? (number)') ?? '';
        legacyDir = found.dataDirs[Number(answer) - 1];
        if (!legacyDir) throw new Error('no folder chosen');
    }
    const options = {
        otherDirs: found.dataDirs,
        activeService: () => activeLegacyService(homedir(), process.getuid?.() ?? 0),
        commands: found.services.flatMap(stopCommands),
    };
    const plan = planMigration(legacyDir, DATA, isDaemonRunning, options);
    if (plan.blocked) throw new Error(plan.blocked);
    if (!plan.steps.length) return console.log('already migrated, nothing to do');
    console.log('Nothing is removed, moved or overwritten. Planned:');
    for (const step of plan.steps) console.log(`  - ${step}`);
    console.log('The files "paused" and "quarantine/" stay in the old folder: they are not copied.');
    if (prompt('No old sync command must be running. Type yes to apply') !== 'yes') return console.log('cancelled');
    const warnings = await applyMigration(plan, {
        readSecret: async (service, name) => (await Bun.secrets.get({ service, name })) ?? null,
        writeSecret: (service, name, value) => Bun.secrets.set({ service, name, value }),
        recheck: () => planMigration(legacyDir!, DATA, isDaemonRunning, options).blocked,
    });
    console.log('Done.');
    for (const warning of warnings) console.log(`warning: ${warning}`);
    console.log('Stop and disable the old service by hand, then start this one:');
    const commands = new Set([...found.services.flatMap(stopCommands), ...knownStopCommands()]);
    for (const command of commands) console.log(`  ${command}`);
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    switch (cmd) {
        case 'init': {
            const [dir, remote] = args;
            if (!dir || !remote) throw new Error('usage: nucleon-sync init <folder> <device:name/folder|root>');
            const localRoot = path.resolve(dir);
            mkdirSync(path.dirname(configPath()), { recursive: true });
            createRootMarker(localRoot);
            const cfg: Config = { localRoot, remote, deviceName: hostname().split('.')[0]!.replace(/[^\w-]/g, ''), maxDeletes: 20 };
            writeFileSync(configPath(), `${JSON.stringify(cfg, null, 4)}\n`);
            console.log(`configuration written: ${configPath()}`);
            return;
        }
        case 'login': {
            const ctx = await sdkContext();
            await signIn(ctx.auth, console.log);
            console.log('logged in');
            await ctx.dispose();
            return;
        }
        case 'logout': {
            const ctx = await sdkContext();
            await ctx.auth.logout();
            console.log('logged out');
            await ctx.dispose();
            return;
        }
        case 'plan':
        case 'once': {
            const cfg = loadConfig();
            const log = logger(cfg.verbose ?? false);
            const ctx = await sdkContext();
            if (!ctx.auth.isLoggedIn()) throw new Error('not logged in: run nucleon-sync login');
            const { engine, store } = await buildEngine(cfg, ctx, log);
            if (cmd === 'plan') printPlan(await engine.planOnly());
            else {
                const approve = store.getKv('approve-deletes') === '1';
                const r = await engine.cycle(approve);
                if (approve) store.setKv('approve-deletes', '0');
                printPlan(r.plan);
                console.log(`done=${r.done} skipped=${r.skipped} errors=${r.errors.length}`);
                for (const e of r.errors) console.log(`error: ${e}`);
            }
            await ctx.dispose();
            return;
        }
        case 'run':
            await daemon(loadConfig());
            return;
        case 'approve': {
            const store = new SqliteStore(path.join(DATA, 'state.sqlite'));
            store.setKv('approve-deletes', '1');
            signalDaemon('SIGUSR1');
            console.log('deletions approved for the next pass');
            return;
        }
        case 'status': {
            let saved: { heartbeatAt: number; view: View } | undefined;
            try {
                saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
            } catch {
                /* no daemon ever ran */
            }
            if (!saved || Date.now() - saved.heartbeatAt > DAEMON_GONE_MS) {
                console.log('Sync stopped: the daemon is not running.');
                return;
            }
            console.log(saved.view.title);
            for (const l of saved.view.lines) console.log(`  ${l}`);
            return;
        }
        case 'setup': {
            console.log(`nucleon-sync setup. ${THIRD_PARTY_NOTICE} Nothing is synced during this assistant.`);
            const command = path.join(homedir(), '.local/bin', APP_NAME);
            const osProblem = serviceProblem(platform());
            if (osProblem) throw new Error(osProblem);
            if (existsSync(configPath())) {
                // Already configured: only the last step is left.
                const cfg = loadConfig();
                console.log(`Already configured: ${cfg.localRoot} <-> ${cfg.remote}. Nothing else to set up.`);
                startSyncing(command);
                return;
            }
            const storeProblem = await sessionStoreProblem(probeSessionStore);
            if (storeProblem) throw new Error(storeProblem);
            const folder = path.resolve(expandHome(prompt('Folder to sync', path.join(homedir(), 'Proton')) ?? '', homedir()));
            if (!isYes(prompt(`Sync the folder ${folder}? [y/N]`))) throw new Error('Folder not confirmed, nothing was done.');
            const otherTool = otherSyncToolFor(folder, homedir(), process.env);
            if (otherTool) throw new Error(otherTool);
            const choice = prompt('Target: 1 = My files (your real Drive), 2 = test space', '1');
            const target = choice === '2' ? 'test' : 'myfiles';
            const confirmed = target === 'myfiles' && prompt('My files holds your real data. Type yes to confirm') === 'yes';
            if (target === 'myfiles' && !confirmed) throw new Error('My files was not confirmed, nothing was done. Choose the test space (2) to try safely.');
            const cfg = buildConfig({ folder, target, confirmed, deviceName: hostname().split('.')[0]!.replace(/[^\w-]/g, '') });
            mkdirSync(folder, { recursive: true });
            createRootMarker(folder);
            const ctx = await sdkContext();
            if (!ctx.auth.isLoggedIn()) await signIn(ctx.auth, console.log);
            const log = logger(false);
            const { engine } = await buildEngine(cfg, ctx, log);
            const plan = await engine.planOnly();
            console.log(`What the first sync would do: ${summarize(plan)}`);
            for (const w of plan.warnings) console.log(`Warning: ${w}`);
            await ctx.dispose();
            // Saved only now: a failed sign-in or plan leaves setup ready to run again.
            mkdirSync(path.dirname(configPath()), { recursive: true });
            saveConfig(cfg);
            startSyncing(command);
            return;
        }
        case 'update':
            console.log(checkForUpdate(path.join(import.meta.dir, '..'), sendNote, () => signalDaemon('SIGTERM')));
            return;
        case 'activity':
            for (const a of recentActivity(path.join(DATA, 'nucleon-sync.log'), Number(args[0]) || 30).reverse()) {
                console.log(`${a.at}  ${a.label}  ${a.path}${a.error ? `  (${a.error})` : ''}`);
            }
            return;
        case 'pause':
            mkdirSync(DATA, { recursive: true });
            writeFileSync(PAUSE_FILE, '');
            signalDaemon('SIGUSR1');
            console.log('paused');
            return;
        case 'resume':
            if (existsSync(PAUSE_FILE)) unlinkSync(PAUSE_FILE);
            signalDaemon('SIGUSR1');
            console.log('resumed');
            return;
        case 'seen': {
            const store = new SqliteStore(path.join(DATA, 'state.sqlite'));
            store.setKv(UNSEEN_KEY, '[]');
            signalDaemon('SIGUSR1');
            return;
        }
        case 'exclude': {
            const [action, pattern] = args;
            const cfg = loadConfig();
            const list = cfg.exclude ?? [];
            if (action === 'list' || !action) {
                for (const p of list) console.log(p);
                return;
            }
            if ((action !== 'add' && action !== 'remove') || !pattern) throw new Error('usage: nucleon-sync exclude list|add <pattern>|remove <pattern>');
            cfg.exclude = action === 'add' ? [...new Set([...list, pattern])] : list.filter((p) => p !== pattern);
            saveConfig(cfg);
            // The patterns are read at start: the service restarts the daemon.
            signalDaemon('SIGTERM');
            console.log(`exclusions: ${cfg.exclude.join(', ') || 'none'}`);
            return;
        }
        case 'migrate':
            await migrate(args);
            return;
        case 'version':
            console.log(APP_VERSION);
            return;
        default:
            console.log('usage: nucleon-sync init|login|logout|plan|once|run|approve|status|pause|resume|seen|activity|exclude|setup|update|migrate|version');
    }
}

main().then(
    () => process.exit(0),
    (e) => {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    },
);
