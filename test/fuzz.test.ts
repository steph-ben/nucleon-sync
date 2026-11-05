import { expect, test } from 'bun:test';

import { run } from './fuzz-lib';

async function check(seed: number, crashRate: number, midOps: boolean) {
    const { hub, devs, doc, doc2, created, userGone } = await run(seed, crashRate, midOps);
    for (const d of devs) d.local.chaos = d.remote.chaos = { before() {} };
    let stable = 0;
    for (let i = 0; i < 40 && stable < 2; i++) {
        let work = 0;
        for (const d of devs) work += (await d.engine.cycle()).plan.actions.length;
        stable = work === 0 ? stable + 1 : 0;
    }
    expect(stable).toBe(2);
    const t = hub.tree();
    for (const d of devs) expect(d.local.tree()).toEqual(t);
    expect(hub.alive(doc)).toBe(true);
    expect(hub.alive(doc2)).toBe(true);

    // Rien ne se perd : seul l'utilisateur peut détruire un contenu.
    const everywhere = new Set<string>();
    for (const n of hub.nodes.values()) for (const c of n.revisions) everywhere.add(c);
    for (const d of devs) {
        for (const c of d.local.quarantined) everywhere.add(c);
        for (const n of d.local.nodes.values()) everywhere.add(n.content);
    }
    const lost = [...created].filter((c) => !everywhere.has(c) && !userGone.has(c));
    expect(lost).toEqual([]);
}

const N = Number(process.env.FUZZ_N ?? 1500);
for (const [label, crash, mid] of [['sans coupure', 0, false], ['avec coupures', 0.04, false], ['coupures et utilisateur actif', 0.04, true]] as const) {
    test(`${label}, ${N} graines`, async () => {
        for (let seed = 1; seed <= N; seed++) {
            try {
                await check(seed, crash, mid);
            } catch (e) {
                console.error(`graine ${seed} (${label})`);
                throw e;
            }
        }
    }, 300000);
}
