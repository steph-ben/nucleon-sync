import { describe, expect, test } from 'bun:test';

import { Engine } from '../src/core/engine';
import { ROOT } from '../src/core/types';
import { PathBusy } from '../src/core/interfaces';
import { Hub, MemStore, SimLocal, SimRemote } from './sim';

function device(tag: string, hub: Hub) {
    const local = new SimLocal(tag);
    const remote = new SimRemote(hub, local);
    const store = new MemStore();
    let k = 0;
    const engine = new Engine(local, remote, store, {
        deviceName: tag,
        caseInsensitive: false,
        maxDeletes: 20,
        newKey: () => `${tag}k${++k}`,
        today: () => '2026-11-05',
    });
    return { local, remote, store, engine };
}

async function settle(...devs: ReturnType<typeof device>[]) {
    for (let i = 0; i < 12; i++) {
        let work = 0;
        for (const d of devs) {
            const r = await d.engine.cycle();
            work += r.plan.actions.length;
        }
        if (work === 0) return;
    }
    throw new Error('ne converge pas');
}

describe('synchro de base', () => {
    test('premier lancement : aucune suppression, appariement par contenu', async () => {
        const hub = new Hub();
        hub.add(ROOT, 'a.txt', 'file', 'A');
        const m = device('M', hub);
        m.local.add(ROOT, 'a.txt', 'file', 'A');
        m.local.add(ROOT, 'b.txt', 'file', 'B');
        await settle(m);
        expect(hub.tree()).toEqual({ 'a.txt': 'A', 'b.txt': 'B' });
        expect(m.local.tree()).toEqual({ 'a.txt': 'A', 'b.txt': 'B' });
    });

    test('renommer un gros dossier = une seule opération, zéro transfert', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const l = device('L', hub);
        const d = m.local.add(ROOT, 'Music', 'dir', '');
        for (let i = 0; i < 300; i++) m.local.add(d.id, `f${i}`, 'file', `c${i}`);
        await settle(m, l);
        let moves = 0;
        let transfers = 0;
        for (const dev of [m, l]) {
            dev.remote.chaos = dev.local.chaos = {
                before(op) {
                    if (op.endsWith('.move')) moves++;
                    if (/upload|download|write/.test(op)) transfers++;
                },
            };
        }
        d.name = 'Musique';
        await settle(m, l);
        expect(moves).toBe(2); // Drive + autre machine
        expect(transfers).toBe(0);
        expect(Object.keys(l.local.tree())).toContain('Musique/f299');
        expect(Object.keys(l.local.tree())).not.toContain('Music/f0');
    });
});

describe('conflits : rien ne se perd', () => {
    async function pair() {
        const hub = new Hub();
        const m = device('M', hub);
        m.local.add(ROOT, 'doc.txt', 'file', 'v1');
        await settle(m);
        return { hub, m, f: m.local.find('doc.txt')! };
    }

    test('modifié des deux côtés : deux versions gardées', async () => {
        const { hub, m, f } = await pair();
        f.content = 'local';
        hub.edit([...hub.nodes.values()][0]!.id, 'distant');
        await settle(m);
        const t = hub.tree();
        expect(t['doc.txt']).toBe('distant');
        expect(t['doc (conflit M 2026-11-05).txt']).toBe('local');
        expect(m.local.tree()).toEqual(t);
    });

    test('supprimé en local, modifié sur le Drive : le fichier revient', async () => {
        const { hub, m, f } = await pair();
        m.local.nodes.delete(f.id);
        hub.edit([...hub.nodes.values()][0]!.id, 'v2');
        await settle(m);
        expect(m.local.tree()).toEqual({ 'doc.txt': 'v2' });
    });

    test('supprimé sur le Drive, modifié en local : renvoyé', async () => {
        const { hub, m, f } = await pair();
        f.content = 'v2';
        hub.trash([...hub.nodes.values()][0]!.id);
        await settle(m);
        expect(hub.tree()).toEqual({ 'doc.txt': 'v2' });
    });

    test('suppression distante : le local passe en quarantaine', async () => {
        const { hub, m } = await pair();
        hub.trash([...hub.nodes.values()][0]!.id);
        await settle(m);
        expect(m.local.tree()).toEqual({});
        expect(m.local.quarantined).toEqual(['v1']);
    });

    test('dossier supprimé mais contenu ajouté de l’autre côté : conservé', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const d = m.local.add(ROOT, 'D', 'dir', '');
        m.local.add(d.id, 'x', 'file', 'X');
        await settle(m);
        const rd = [...hub.nodes.values()].find((n) => n.name === 'D')!;
        hub.trash(rd.id);
        m.local.add(d.id, 'neuf', 'file', 'N');
        await settle(m);
        expect(hub.tree()['D/neuf']).toBe('N');
        expect(m.local.tree()['D/neuf']).toBe('N');
    });
});

describe('garde-fous', () => {
    test('doc Proton jamais touché : son dossier n’est pas mis à la corbeille', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const rd = hub.add(ROOT, 'Reloger', 'dir', '');
        const doc = hub.add(rd.id, 'Meublingo', 'file', '', true);
        hub.add(rd.id, 'plan.pdf', 'file', 'P');
        await settle(m);
        expect(m.local.tree()).toEqual({ Reloger: '<dir>', 'Reloger/plan.pdf': 'P' });
        const ld = m.local.find('Reloger')!;
        m.local.nodes.delete(ld.id);
        m.local.nodes.delete(m.local.find('Reloger/plan.pdf')?.id ?? '');
        for (const n of m.local.nodes.values()) if (n.parent === ld.id) m.local.nodes.delete(n.id);
        await settle(m);
        expect(doc.trashed).toBe(false);
        expect(rd.trashed).toBe(false);
        expect(hub.alive(doc)).toBe(true);
    });

    test('grosse suppression : retenue jusqu’à approbation', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        for (let i = 0; i < 30; i++) m.local.add(ROOT, `f${i}`, 'file', `c${i}`);
        await settle(m);
        for (const n of [...m.local.nodes.values()]) m.local.nodes.delete(n.id);
        m.local.add(ROOT, 'reste', 'file', 'r');
        const r = await m.engine.cycle();
        expect(r.plan.held.length).toBeGreaterThan(0);
        expect(Object.keys(hub.tree()).length).toBe(31);
        await m.engine.cycle(true);
        expect(Object.keys(hub.tree())).toEqual(['reste']);
    });

    test('dossier local vidé d’un coup : arrêt', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        for (const n of ['a', 'b', 'c', 'd', 'e']) m.local.add(ROOT, n, 'file', n);
        await settle(m);
        m.local.nodes.clear();
        await expect(m.engine.cycle()).rejects.toThrow('vide');
        expect(Object.keys(hub.tree()).length).toBe(5);
    });

    test('racine absente : arrêt', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        m.local.rootOk = false;
        await expect(m.engine.cycle()).rejects.toThrow('racine');
    });
});

describe('déplacements croisés', () => {
    test('A dans un dossier neuf sous B, et B dans A : aucun cycle, rien de perdu', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const a = m.local.add(ROOT, 'A', 'dir', '');
        const b = m.local.add(ROOT, 'B', 'dir', '');
        m.local.add(a.id, 'fa', 'file', 'FA');
        m.local.add(b.id, 'fb', 'file', 'FB');
        await settle(m);
        const n = m.local.add(b.id, 'N', 'dir', '');
        a.parent = n.id;
        const ra = [...hub.nodes.values()].find((x) => x.name === 'A')!;
        const rb = [...hub.nodes.values()].find((x) => x.name === 'B')!;
        hub.rename(rb.id, ra.id, 'B');
        await settle(m);
        const contents = Object.values(hub.tree());
        expect(contents).toContain('FA');
        expect(contents).toContain('FB');
        expect(m.local.tree()).toEqual(hub.tree());
    }, 5000);
});

describe('corbeille', () => {
    test('déplacement bloqué : le dossier source ne part pas à la corbeille avec un doc Proton', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const rx = hub.add(ROOT, 'X', 'dir', '');
        const rr = hub.add(rx.id, 'Reloger', 'dir', '');
        const doc = hub.add(rr.id, 'Meublingo', 'file', '', true);
        await settle(m);
        const x = m.local.find('X')!;
        const r = m.local.find('X/Reloger')!;
        r.parent = ROOT;
        m.local.nodes.delete(x.id);
        let blocked = true;
        m.remote.chaos = {
            before(op) {
                if (op === 'remote.move' && blocked) throw new PathBusy('occupé');
            },
        };
        await m.engine.cycle();
        expect(hub.alive(doc)).toBe(true);
        blocked = false;
        await settle(m);
        expect(hub.alive(doc)).toBe(true);
        expect(hub.tree()).toEqual({ Reloger: '<dir>' });
    });
});

describe('inversion', () => {
    test('un dossier enfant devient le parent de son ancien parent', async () => {
        const hub = new Hub();
        const m = device('M', hub);
        const rb = hub.add(ROOT, 'b', 'dir', '');
        const ra = hub.add(rb.id, 'a', 'dir', '');
        hub.add(ra.id, 'f', 'file', 'F');
        await settle(m);
        hub.rename(ra.id, ROOT, 'd');
        hub.rename(rb.id, ra.id, 'b');
        await settle(m);
        expect(m.local.tree()).toEqual(hub.tree());
        expect(hub.tree()['d/f']).toBe('F');
    });
});
