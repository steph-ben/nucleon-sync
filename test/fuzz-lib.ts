import { Engine } from '../src/core/engine';
import { ROOT } from '../src/core/types';
import { Crash, Hub, MemStore, SimLocal, SimRemote } from './sim';

function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const NAMES = ['a', 'b', 'c', 'd', 'Music', 'Musique'];

export async function run(seed: number, crashRate: number, midOps: boolean) {
    const rand = rng(seed);
    const pick = <T>(l: T[]) => l[Math.floor(rand() * l.length)]!;
    const hub = new Hub();
    let uniq = 0;
    const fresh = () => `#${seed}.${++uniq}`;

    const mk = (tag: string) => {
        const local = new SimLocal(tag);
        const remote = new SimRemote(hub, local);
        const store = new MemStore();
        let k = 0;
        const engine = new Engine(local, remote, store, { deviceName: tag, caseInsensitive: false, maxDeletes: 1e9, isFatal: (e) => e instanceof Crash, newKey: () => `${tag}k${++k}`, today: () => '2026-11-05' });
        return { tag, local, remote, store, engine };
    };
    const devs = [mk('M'), mk('L')];
    const doc = hub.add(ROOT, 'native-doc', 'file', 'NATIVE', true);
    const protectedDir = hub.add(ROOT, 'Reloger', 'dir', '');
    const doc2 = hub.add(protectedDir.id, 'Meublingo', 'file', 'NATIVE2', true);

    /** Contenus qui ont été synchronisés au moins une fois : ils ne doivent jamais disparaître. */
    const synced = new Set<string>();

    const userOnLocal = (l: SimLocal) => {
        const nodes = [...l.nodes.values()];
        const dirs = nodes.filter((n) => n.kind === 'dir');
        const parent = dirs.length && rand() < 0.5 ? pick(dirs).id : ROOT;
        const free = (p: string) => NAMES.filter((n) => ![...l.nodes.values()].some((x) => x.parent === p && x.name === n));
        const r = rand();
        if (r < 0.3 || !nodes.length) {
            const f = free(parent);
            if (f.length) l.add(parent, pick(f), rand() < 0.3 ? 'dir' : 'file', fresh());
        } else if (r < 0.55) {
            const files = nodes.filter((n) => n.kind === 'file');
            if (files.length) {
                const n = pick(files);
                n.content = fresh();
                n.mtime = ++l.clock;
                // Sauvegarde atomique d'éditeur : parfois un nouvel inode au même endroit.
                if (rand() < 0.3) {
                    l.nodes.delete(n.id);
                    l.add(n.parent, n.name, 'file', n.content);
                }
            }
        } else if (r < 0.85) {
            const n = pick(nodes);
            const banned = new Set(l.subtree(n.id).map((x) => x.id));
            const targets = [ROOT, ...dirs.map((d) => d.id)].filter((p) => !banned.has(p));
            const p = pick(targets);
            const f = free(p);
            if (f.length) {
                n.parent = p;
                n.name = pick(f);
            }
        } else {
            const n = pick(nodes);
            for (const c of l.subtree(n.id)) l.nodes.delete(c.id);
        }
    };

    const userOnWeb = () => {
        const nodes = [...hub.nodes.values()].filter((n) => hub.alive(n) && !n.protected && n !== protectedDir);
        const dirs = nodes.filter((n) => n.kind === 'dir');
        const parent = dirs.length && rand() < 0.5 ? pick(dirs).id : ROOT;
        const r = rand();
        const name = pick(NAMES);
        if (r < 0.3 || !nodes.length) {
            if (!hub.taken(parent, name)) hub.add(parent, name, rand() < 0.3 ? 'dir' : 'file', fresh());
        } else if (r < 0.55) {
            const files = nodes.filter((n) => n.kind === 'file');
            if (files.length) hub.edit(pick(files).id, fresh());
        } else if (r < 0.85) {
            const n = pick(nodes);
            const sub = new Set<string>();
            const walk = (id: string) => {
                sub.add(id);
                for (const c of hub.nodes.values()) if (c.parent === id) walk(c.id);
            };
            walk(n.id);
            const targets = [ROOT, ...dirs.map((d) => d.id)].filter((p) => !sub.has(p));
            const p = pick(targets);
            if (!hub.taken(p, name, n.id)) hub.rename(n.id, p, name);
        } else hub.trash(pick(nodes).id);
    };

    const chaos = (l: SimLocal) => ({
        before() {
            if (rand() < crashRate) throw new Crash('coupure');
            if (midOps && rand() < 0.03) userOnLocal(l); // l'utilisateur agit pendant la synchro
        },
    });
    for (const d of devs) d.local.chaos = d.remote.chaos = chaos(d.local);

    const remember = (l: SimLocal) => {
        for (const n of l.nodes.values()) if (n.kind === 'file' && n.content) synced.add(n.content);
    };

    const rounds = 3 + Math.floor(rand() * 8);
    for (let i = 0; i < rounds; i++) {
        const n = 1 + Math.floor(rand() * 5);
        for (let j = 0; j < n; j++) {
            const r = rand();
            if (r < 0.4) userOnLocal(devs[0]!.local);
            else if (r < 0.8) userOnLocal(devs[1]!.local);
            else userOnWeb();
        }
        for (const d of devs) {
            if (rand() > 0.75) continue;
            try {
                await d.engine.cycle();
                remember(d.local);
            } catch (e) {
                if (!(e instanceof Crash) && process.env.FUZZ_STRICT) throw e;
            }
        }
    }
    return { hub, devs, doc, doc2, synced };
}

/** Pour test/debug-seed.ts : montre la passe qui lève une erreur. */
export async function replay(seed: number, crash: number, mid: boolean) {
    const { hub, devs } = await run(seed, crash, mid);
    for (const d of devs) d.local.chaos = d.remote.chaos = { before() {} };
    for (let i = 0; i < 40; i++) {
        for (const d of devs) {
            const plan = await d.engine.planOnly();
            console.log('---', d.tag, 'passe', i, JSON.stringify(plan.actions), plan.warnings);
            console.log('LOCAL', JSON.stringify(d.local.tree()));
            console.log('HUB  ', JSON.stringify(hub.tree()));
            console.log('BASE ', JSON.stringify(d.store.all().map((r) => [r.key, r.parent, r.name, r.localId, r.remoteId])));
            console.log('RESULT', JSON.stringify((await d.engine.cycle()).errors));
        }
    }
}
