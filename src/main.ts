#!/usr/bin/env bun
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, watch, writeFileSync, writeSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import path from 'node:path';

import { createRootMarker, defaultIgnore, detectCaseInsensitive, RealLocalFs } from './adapters/local';
import { ProtonRemote } from './adapters/proton';
import { SqliteStore } from './adapters/sqlite-store';
import { Engine, SafetyStop } from './core/engine';
import type { Logger, Plan } from './core/types';
import { ChangeTracker } from './watch';

const VERSION = '0.1.0';
const APP_VERSION = `external-drive-protonsync@${VERSION}-stable`;
const DATA = process.env.PROTON_SYNC_HOME ?? path.join(homedir(), '.local/share/proton-sync');
const POLL_SECONDS = 60;
const DEBOUNCE_MS = 3000;
const HEARTBEAT_MS = 60 * 60 * 1000;

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
    /** Detailed log: watcher events, wake-up causes, duration of each pass. */
    verbose?: boolean;
}

function configPath() {
    return process.env.PROTON_SYNC_CONFIG ?? path.join(DATA, 'config.json');
}

function loadConfig(): Config {
    const file = configPath();
    if (!existsSync(file)) throw new Error(`configuration missing: ${file}. Run: proton-sync init <folder> <device:name/folder|root>`);
    return JSON.parse(readFileSync(file, 'utf8')) as Config;
}

/** One line per event: "<ISO time> <LEVEL> <message>". DEBUG lines only when `verbose` is on. */
function logger(verbose = false): Logger {
    mkdirSync(DATA, { recursive: true });
    const file = path.join(DATA, 'proton-sync.log');
    return (level, message) => {
        if (level === 'DEBUG' && !verbose) return;
        const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
        appendFileSync(file, `${line}\n`);
        if (process.stdout.isTTY) console.log(line);
    };
}

async function sdkContext() {
    process.env.PROTON_DRIVE_CACHE_DIR ??= path.join(DATA, 'sdk');
    process.env.PROTON_DRIVE_LOG_LEVEL ??= 'WARNING';
    const { init } = await import('../vendor/proton-sdk/cli/src/init');
    return init({ appVersion: APP_VERSION, clientUidPrefix: 'external-drive-protonsync', enablePersistedEvents: false, enableMetrics: false, flags: {} });
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

async function buildEngine(cfg: Config, ctx: Ctx, log: Logger, touched?: (paths: string[]) => void) {
    mkdirSync(DATA, { recursive: true });
    const store = new SqliteStore(path.join(DATA, 'state.sqlite'));
    const quarantine = path.join(DATA, 'quarantine');
    const local = new RealLocalFs(cfg.localRoot, quarantine, { ignore: defaultIgnore });
    await local.assertRootSafe();
    const { rootUid, scopeId } = await resolveRoot(ctx, cfg);
    const remote = new ProtonRemote(ctx.sdk, rootUid, scopeId, store, log, (p) => local.absolutePath(p), defaultIgnore);
    const engine = new Engine(local, remote, store, {
        deviceName: cfg.deviceName,
        caseInsensitive: await detectCaseInsensitive(cfg.localRoot),
        maxDeletes: cfg.maxDeletes,
        newKey: () => crypto.randomUUID(),
        today: () => new Date().toISOString().slice(0, 10),
        log,
        touched,
    });
    return { engine, store };
}

function summarize(plan: Plan) {
    const counts = new Map<string, number>();
    for (const a of plan.actions) counts.set(a.t, (counts.get(a.t) ?? 0) + 1);
    return [...counts].map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing to do';
}

function acquireLock() {
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
    acquireLock();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
            log('INFO', `daemon stopping (${signal})`);
            process.exit(0);
        });
    }
    const ctx = await sdkContext();
    if (!ctx.auth.isLoggedIn()) throw new Error('not logged in: run proton-sync login');
    const tracker = new ChangeTracker(defaultIgnore);
    const { engine, store } = await buildEngine(cfg, ctx, log, (paths) => tracker.own(paths, Date.now()));

    let wake: (() => void) | undefined;
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
    let pass = 0;
    let lastHeld = -1;
    let lastWarnings = new Set<string>();
    let beat = { at: Date.now(), passes: 0, withErrors: 0 };
    for (;;) {
        let delay = POLL_SECONDS * 1000;
        const started = Date.now();
        const local = tracker.drain();
        pass++;
        beat.passes++;
        running = true;
        log('INFO', `pass ${pass} start: ${cause}${local.length ? `; local changes: ${some(local)}` : ''}`);
        try {
            const approve = store.getKv('approve-deletes') === '1';
            const r = await engine.cycle(approve);
            if (approve) store.setKv('approve-deletes', '0');
            store.setKv('status', JSON.stringify({ at: new Date().toISOString(), summary: summarize(r.plan), held: r.plan.held.length, warnings: r.plan.warnings, errors: r.errors }));
            const took = seconds(Date.now() - started);
            if (r.plan.actions.length || r.errors.length) log('INFO', `pass ${pass} done in ${took}: done=${r.done} skipped=${r.skipped} errors=${r.errors.length}`);
            else log('DEBUG', `pass ${pass} done in ${took}: nothing to do`);
            // Warn once per new problem, not every minute.
            for (const w of r.plan.warnings) if (!lastWarnings.has(w)) log('WARN', w);
            lastWarnings = new Set(r.plan.warnings);
            if (r.plan.held.length !== lastHeld) {
                if (r.plan.heldReason === 'incomplete-scan') log('WARN', `${r.plan.held.length} deletions postponed until every file can be read again`);
                else if (r.plan.held.length) log('WARN', `${r.plan.held.length} deletions held (limit ${cfg.maxDeletes}): review with 'proton-sync plan', then run 'proton-sync approve'`);
                lastHeld = r.plan.held.length;
            }
            if (r.errors.length) beat.withErrors++;
            failures = r.errors.length ? failures + 1 : 0;
            // Work was done: run again soon to confirm the state is stable.
            if (r.plan.actions.length) delay = 2000;
        } catch (e) {
            failures++;
            beat.withErrors++;
            const safety = e instanceof SafetyStop;
            const message = e instanceof Error ? e.message : String(e);
            log('ERROR', `${safety ? 'safety stop (no file was touched)' : `pass ${pass} failed`}: ${message}`);
            store.setKv('status', JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
        } finally {
            running = false;
        }
        if (failures) {
            delay = Math.min(POLL_SECONDS * 1000 * 2 ** Math.min(failures, 4), 15 * 60 * 1000);
            log('WARN', `retrying in ${Math.round(delay / 1000)} s (consecutive failed passes: ${failures})`);
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

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    switch (cmd) {
        case 'init': {
            const [dir, remote] = args;
            if (!dir || !remote) throw new Error('usage: proton-sync init <folder> <device:name/folder|root>');
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
            await ctx.auth.authViaWeb((url: string) => console.log(`Open this address to log in:\n${url}`));
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
            if (!ctx.auth.isLoggedIn()) throw new Error('not logged in: run proton-sync login');
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
            console.log('deletions approved for the next pass');
            return;
        }
        case 'status': {
            const store = new SqliteStore(path.join(DATA, 'state.sqlite'));
            console.log(store.getKv('status') ?? 'no pass recorded');
            return;
        }
        case 'version':
            console.log(APP_VERSION);
            return;
        default:
            console.log('usage: proton-sync init|login|logout|plan|once|run|approve|status|version');
    }
}

main().then(
    () => process.exit(0),
    (e) => {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    },
);
