import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { detectCaseInsensitive } from '../src/adapters/local';
import { Crash, instrument } from './lib/crash';
import { cleanWorlds, fullTree, type Machine, tree, world } from './lib/world';

afterEach(cleanWorlds);

const NAMES = ['a', 'A', 'b', 'Été', 'Été', 'Musique', 'photo 1.jpg', '📷'];
const N = Number(process.env.FUZZ_REAL_N ?? 120);

function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function run(seed: number, caseInsensitive: boolean, crashes: boolean) {
    const rand = rng(seed);
    const pick = <T>(l: T[]) => l[Math.floor(rand() * l.length)]!;
    const trace = process.env.FUZZ_TRACE ? (...a: unknown[]) => console.log(...a) : () => {};
    const w = world({ caseInsensitive, isFatal: (e) => e instanceof Crash, log: (l, m) => trace(l, m) });
    w.ledger.trackWrites = false;
    const fold = (s: string) => (caseInsensitive ? s.normalize('NFC').toLowerCase() : s.normalize('NFC'));
    let uniq = 0;
    const fresh = () => `#${seed}.${++uniq}`;

    const dirsOf = (t: Record<string, string>) => Object.keys(t).filter((p) => t[p] === '<dir>');
    const freeIn = (t: Record<string, string>, dir: string) => {
        const taken = new Set(Object.keys(t).map(fold));
        return NAMES.map((n) => (dir ? `${dir}/${n}` : n)).filter((p) => !taken.has(fold(p)));
    };
    const local = (m: Machine) => {
        // Names as stored: Linux keeps NFD and NFC apart, so a normalized path may not exist.
        const t = fullTree(m.root, '', true);
        const raw = (p: string) => p;
        const dir = rand() < 0.5 && dirsOf(t).length ? pick(dirsOf(t)) : '';
        const paths = Object.keys(t);
        const r = rand();
        const free = freeIn(t, dir);
        if ((r < 0.3 || !paths.length) && free.length) {
            if (rand() < 0.3) w.mkdir(m, raw(pick(free)));
            else w.write(m, pick(free), fresh());
        } else if (r < 0.55) {
            const files = paths.filter((p) => t[p] !== '<dir>');
            if (files.length) {
                const victim = pick(files);
                trace(`USER overwrite on ${m.tag}: ${victim}`, t[victim]);
                w.ledger.forgive(t[victim]!);
                w.write(m, victim, fresh());
            }
        } else if (r < 0.85 && paths.length && free.length) {
            const from = pick(paths);
            const to = pick(free);
            if (!fold(to).startsWith(`${fold(from)}/`) && fold(to) !== fold(from)) w.move(m, from, to);
        } else if (paths.length) {
            const victim = pick(paths);
            trace(`USER rm on ${m.tag}: ${victim}`, JSON.stringify(t));
            for (const [p, c] of Object.entries(tree(m.root))) if (p === victim || p.startsWith(`${victim}/`)) w.ledger.forgive(c);
            w.rm(m, victim);
        }
    };
    const web = () => {
        const t = w.hub.tree();
        const dir = rand() < 0.5 && dirsOf(t).length ? pick(dirsOf(t)) : '';
        const paths = Object.keys(t);
        const r = rand();
        const free = freeIn(t, dir);
        if ((r < 0.3 || !paths.length) && free.length) {
            if (rand() < 0.3) w.web.mkdir(pick(free));
            else w.web.write(pick(free), fresh());
        } else if (r < 0.55) {
            const files = paths.filter((p) => t[p] !== '<dir>');
            if (files.length) w.web.write(pick(files), fresh());
        } else if (r < 0.85 && paths.length && free.length) {
            const from = pick(paths);
            const to = pick(free);
            if (!fold(to).startsWith(`${fold(from)}/`) && fold(to) !== fold(from)) w.web.move(from, to);
        } else if (paths.length) w.web.trash(pick(paths));
    };

    let crashAt = -1;
    let n = 0;
    if (crashes) {
        for (const m of [w.a, w.b]) {
            instrument(m, () => {
                if (n++ === crashAt) {
                    trace('CRASH');
                    throw new Crash('crash');
                }
            });
        }
    }
    /** The sync saw what is on this machine and on the Drive when a pass starts. */
    const pass = async (m: Machine) => {
        for (const c of Object.values(tree(m.root))) w.ledger.saw(c);
        trace(`--- pass ${m.tag}`, JSON.stringify(tree(m.root)), 'HUB', JSON.stringify(w.hub.tree()));
        await m.engine.cycle(true).catch((e) => {
            if (!(e instanceof Crash) && !/empty/.test(String(e))) throw e;
        });
    };
    const rounds = 3 + Math.floor(rand() * 6);
    for (let i = 0; i < rounds; i++) {
        for (let j = 1 + Math.floor(rand() * 4); j > 0; j--) {
            const r = rand();
            if (r < 0.4) local(w.a);
            else if (r < 0.8) local(w.b);
            else web();
        }
        crashAt = crashes && rand() < 0.5 ? n + Math.floor(rand() * 6) : -1;
        await pass(w.a);
        if (rand() < 0.75) await pass(w.b);
    }
    crashAt = -1;
    let stable = 0;
    for (let i = 0; i < 40 && stable < 2; i++) {
        let work = 0;
        for (const m of [w.a, w.b]) {
            for (const c of Object.values(tree(m.root))) w.ledger.saw(c);
            const r = await m.engine.cycle(true);
            trace(`=== settle ${m.tag}`, JSON.stringify(r.plan.actions), r.plan.warnings, r.errors, JSON.stringify(fullTree(m.root)), JSON.stringify(w.hub.tree()));
            work += r.plan.actions.length;
        }
        stable = work ? 0 : stable + 1;
    }
    expect(stable).toBe(2);
    w.assertConverged();
}

for (const [label, crashes] of [['no crashes', false], ['with crashes', true]] as const) {
    test(`real files, ${label}, ${N} seeds`, async () => {
        const probe = mkdtempSync(path.join(tmpdir(), 'proton-sync-case-'));
        const ci = await detectCaseInsensitive(probe);
        rmSync(probe, { recursive: true, force: true });
        for (let seed = Number(process.env.FUZZ_SEED ?? 1); seed <= (process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : N); seed++) {
            try {
                await run(seed, ci, crashes);
            } catch (e) {
                console.error(`seed ${seed} (${label})`);
                throw e;
            } finally {
                cleanWorlds();
            }
        }
    }, 600000);
}
