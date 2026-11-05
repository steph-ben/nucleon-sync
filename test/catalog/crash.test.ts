import { describe, expect } from 'bun:test';

import { row } from '../lib/catalog';
import { Crash, instrument } from '../lib/crash';
import { world } from '../lib/world';

const area = 'Crash at every step';
const FULL_LIMIT = 50;
type World = ReturnType<typeof world>;

async function seeded() {
    const w = world({ isFatal: (e) => e instanceof Crash });
    for (const f of ['Albums/a.jpg', 'Albums/b.jpg', 'Albums/sous/c.jpg', 'Notes/n.md', 'Notes/m.md', 'z.txt', 'y.txt']) w.write(w.a, f, `contenu ${f}`);
    await w.settle();
    return w;
}

const SCENARIOS: Record<string, (w: World) => void> = {
    'a busy day': (w) => {
        w.write(w.a, 'Nouveau/dossier/neuf.txt', 'neuf');
        w.write(w.a, 'z.txt', 'version 2');
        w.move(w.a, 'Notes/m.md', 'Albums/m.md');
        w.rm(w.a, 'Notes/n.md');
        w.web.write('fichier.txt', 'du web');
        w.web.write('y.txt', 'y version web');
    },
    'folder rename and move': (w) => {
        w.move(w.a, 'Albums', 'Vacances');
        w.move(w.a, 'Notes', 'Vacances/Carnets');
    },
    'remote rename and move': (w) => {
        w.web.move('Albums', 'Photos');
        w.web.move('Notes/n.md', 'Photos/n.md');
    },
    'edit on both sides': (w) => {
        w.write(w.a, 'z.txt', 'local');
        w.web.write('z.txt', 'web');
    },
    'new version from the Drive': (w) => {
        w.web.write('z.txt', 'v2');
        w.web.write('Notes/n.md', 'n2');
    },
    'delete on one side, edit on the other': (w) => {
        w.rm(w.a, 'Albums');
        w.web.write('Albums/a.jpg', 'gardée');
    },
    'names swapped': (w) => {
        w.move(w.a, 'y.txt', 'tmp');
        w.move(w.a, 'z.txt', 'y.txt');
        w.move(w.a, 'tmp', 'z.txt');
    },
    'folder emptied by a delete': (w) => {
        w.web.trash('Albums');
    },
};

async function countOps(run: (w: World) => void) {
    const w = await seeded();
    let n = 0;
    instrument(w.a, () => n++);
    run(w);
    await w.settle(w.a);
    return n;
}

describe('crash at every step', () => {
    for (const [name, run] of Object.entries(SCENARIOS)) {
        row(
            { id: `crash.${name.replaceAll(' ', '-').replaceAll(',', '')}`, area, gesture: `${name}: killed before and after each single operation`, expected: 'After restart everything converges and nothing is lost' },
            async () => {
                const total = await countOps(run);
                expect(total).toBeGreaterThan(0);
                expect(total).toBeLessThan(FULL_LIMIT * 2);
                for (let at = 0; at < total; at++) {
                    const w = await seeded();
                    let n = 0;
                    let crashed = false;
                    instrument(w.a, () => {
                        if (n++ === at) {
                            crashed = true;
                            throw new Crash(`at ${at}`);
                        }
                    });
                    run(w);
                    await w.a.engine.cycle().catch((e) => {
                        if (!(e instanceof Crash)) throw e;
                    });
                    expect(crashed).toBe(true);
                    for (let i = 0; i < 16; i++) {
                        let work = 0;
                        for (const m of [w.a, w.b]) work += (await m.engine.cycle()).plan.actions.length;
                        if (!work) break;
                    }
                    try {
                        w.assertConverged();
                    } catch (e) {
                        throw new Error(`crash at step ${at} of ${total}: ${(e as Error).message}`);
                    }
                }
            },
            120000,
        );
    }
});
