#!/usr/bin/env bun
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, watch, writeFileSync, writeSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import path from 'node:path';

import { createRootMarker, defaultIgnore, detectCaseInsensitive, RealLocalFs } from './adapters/local';
import { ProtonRemote } from './adapters/proton';
import { SqliteStore } from './adapters/sqlite-store';
import { Engine, SafetyStop } from './core/engine';
import type { Plan } from './core/types';

const VERSION = '0.1.0';
const APP_VERSION = `external-drive-protonsync@${VERSION}-stable`;
const DATA = process.env.PROTON_SYNC_HOME ?? path.join(homedir(), '.local/share/proton-sync');
const POLL_SECONDS = 60;
const DEBOUNCE_MS = 3000;

interface Config {
    localRoot: string;
    /** `device:<nom>` pour un espace isolé, `root` pour Mes fichiers. */
    remote: string;
    deviceName: string;
    maxDeletes: number;
    /** Doit être vrai pour synchroniser Mes fichiers : protège contre un lancement de test sur le vrai Drive. */
    allowDriveRoot?: boolean;
}

function configPath() {
    return process.env.PROTON_SYNC_CONFIG ?? path.join(DATA, 'config.json');
}

function loadConfig(): Config {
    const file = configPath();
    if (!existsSync(file)) throw new Error(`configuration absente : ${file}. Lancer : proton-sync init <dossier> <device:nom|root>`);
    return JSON.parse(readFileSync(file, 'utf8')) as Config;
}

function logger() {
    mkdirSync(DATA, { recursive: true });
    const file = path.join(DATA, 'proton-sync.log');
    return (s: string) => {
        const line = `${new Date().toISOString()} ${s}`;
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
        if (!cfg.allowDriveRoot) throw new Error('synchroniser Mes fichiers demande "allowDriveRoot": true dans la configuration');
        const root = await ctx.sdk.getMyFilesRootFolder();
        return { rootUid: root.uid, scopeId: root.treeEventScopeId };
    }
    const m = /^device:(.+)$/.exec(cfg.remote);
    if (!m) throw new Error(`cible distante invalide : ${cfg.remote}`);
    let device;
    for await (const d of ctx.sdk.iterateDevices()) if (d.name.ok && d.name.value === m[1]) device = d;
    if (!device) {
        const { DeviceType } = await import('@protontech/drive-sdk');
        device = await ctx.sdk.createDevice(m[1]!, platform() === 'darwin' ? DeviceType.MacOS : DeviceType.Linux);
    }
    const root = await ctx.sdk.getNode(device.rootFolderUid);
    return { rootUid: root.uid, scopeId: root.treeEventScopeId };
}

async function buildEngine(cfg: Config, ctx: Ctx, log: (s: string) => void) {
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
    });
    return { engine, store };
}

function summarize(plan: Plan) {
    const counts = new Map<string, number>();
    for (const a of plan.actions) counts.set(a.t, (counts.get(a.t) ?? 0) + 1);
    return [...counts].map(([k, v]) => `${k}=${v}`).join(' ') || 'rien à faire';
}

function acquireLock() {
    const file = path.join(DATA, 'daemon.lock');
    mkdirSync(DATA, { recursive: true });
    if (existsSync(file)) {
        const pid = Number(readFileSync(file, 'utf8'));
        try {
            process.kill(pid, 0);
            throw new Error(`déjà en cours (pid ${pid})`);
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
            /* rien à faire */
        }
    });
}

async function daemon(cfg: Config) {
    const log = logger();
    acquireLock();
    const ctx = await sdkContext();
    if (!ctx.auth.isLoggedIn()) throw new Error('non connecté : lancer proton-sync login');
    const { engine, store } = await buildEngine(cfg, ctx, log);

    let wake: (() => void) | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const trigger = () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => wake?.(), DEBOUNCE_MS);
    };
    // Le scan reste la référence : la surveillance sert seulement à réagir vite.
    watch(cfg.localRoot, { recursive: true }, (_e, name) => {
        if (name && !String(name).includes('.proton-sync-tmp')) trigger();
    });

    let failures = 0;
    log(`démarrage ${APP_VERSION} racine=${cfg.localRoot} cible=${cfg.remote}`);
    for (;;) {
        let delay = POLL_SECONDS * 1000;
        try {
            const approve = store.getKv('approve-deletes') === '1';
            const r = await engine.cycle(approve);
            if (approve) store.setKv('approve-deletes', '0');
            store.setKv('status', JSON.stringify({ at: new Date().toISOString(), summary: summarize(r.plan), held: r.plan.held.length, warnings: r.plan.warnings, errors: r.errors }));
            if (r.plan.actions.length || r.errors.length) log(`${summarize(r.plan)} erreurs=${r.errors.length} ${r.errors.slice(0, 3).join(' | ')}`);
            if (r.plan.held.length) log(`${r.plan.held.length} suppressions en attente : proton-sync plan, puis proton-sync approve`);
            failures = r.errors.length ? failures + 1 : 0;
            // Du travail fait : repasser vite pour confirmer l'état stable.
            if (r.plan.actions.length) delay = 2000;
        } catch (e) {
            failures++;
            const safety = e instanceof SafetyStop;
            log(`${safety ? 'ARRÊT DE SÉCURITÉ' : 'erreur'} : ${e instanceof Error ? e.message : String(e)}`);
            store.setKv('status', JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
        }
        if (failures) delay = Math.min(POLL_SECONDS * 1000 * 2 ** Math.min(failures, 4), 15 * 60 * 1000);
        await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, delay);
            wake = () => {
                clearTimeout(t);
                resolve();
            };
        });
    }
}

function printPlan(plan: Plan) {
    console.log(`résumé : ${summarize(plan)}`);
    for (const a of plan.actions) console.log(JSON.stringify(a));
    if (plan.held.length) console.log(`retenues (${plan.held.length}) :`);
    for (const a of plan.held) console.log(JSON.stringify(a));
    for (const w of plan.warnings) console.log(`attention : ${w}`);
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    switch (cmd) {
        case 'init': {
            const [dir, remote] = args;
            if (!dir || !remote) throw new Error('usage : proton-sync init <dossier> <device:nom|root>');
            const localRoot = path.resolve(dir);
            mkdirSync(path.dirname(configPath()), { recursive: true });
            createRootMarker(localRoot);
            const cfg: Config = { localRoot, remote, deviceName: hostname().split('.')[0]!.replace(/[^\w-]/g, ''), maxDeletes: 20 };
            writeFileSync(configPath(), `${JSON.stringify(cfg, null, 4)}\n`);
            console.log(`configuration écrite : ${configPath()}`);
            return;
        }
        case 'login': {
            const ctx = await sdkContext();
            await ctx.auth.authViaWeb((url: string) => console.log(`Ouvre cette adresse pour te connecter :\n${url}`));
            console.log('connecté');
            await ctx.dispose();
            return;
        }
        case 'logout': {
            const ctx = await sdkContext();
            await ctx.auth.logout();
            console.log('déconnecté');
            await ctx.dispose();
            return;
        }
        case 'plan':
        case 'once': {
            const cfg = loadConfig();
            const log = logger();
            const ctx = await sdkContext();
            if (!ctx.auth.isLoggedIn()) throw new Error('non connecté : lancer proton-sync login');
            const { engine } = await buildEngine(cfg, ctx, log);
            if (cmd === 'plan') printPlan(await engine.planOnly());
            else {
                const r = await engine.cycle();
                printPlan(r.plan);
                console.log(`fait=${r.done} ignorées=${r.skipped} erreurs=${r.errors.length}`);
                for (const e of r.errors) console.log(`erreur : ${e}`);
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
            console.log('suppressions approuvées pour la prochaine passe');
            return;
        }
        case 'status': {
            const store = new SqliteStore(path.join(DATA, 'state.sqlite'));
            console.log(store.getKv('status') ?? 'aucune passe enregistrée');
            return;
        }
        case 'version':
            console.log(APP_VERSION);
            return;
        default:
            console.log('usage : proton-sync init|login|logout|plan|once|run|approve|status|version');
    }
}

main().then(
    () => process.exit(0),
    (e) => {
        console.error(`erreur : ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    },
);
