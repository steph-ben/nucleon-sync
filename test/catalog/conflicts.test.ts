import { describe, expect } from 'bun:test';

import { row } from '../lib/catalog';
import { type Machine, world } from '../lib/world';

const area = 'Conflict matrix';
type World = ReturnType<typeof world>;
const GESTURES = ['none', 'edit', 'rename', 'move', 'delete', 'parent renamed', 'parent moved', 'parent deleted'] as const;
type Gesture = (typeof GESTURES)[number];

const F = 'P/S/f';
const ORIGINAL = 'original';

async function seeded() {
    const w = world();
    w.write(w.a, F, ORIGINAL);
    w.write(w.a, 'P/S/frere', 'frère');
    w.mkdir(w.a, 'Autre');
    await w.settle();
    return w;
}

function localGesture(w: World, m: Machine, g: Gesture) {
    if (g === 'edit') w.write(m, F, 'edit local');
    if (g === 'rename') w.move(m, F, 'P/S/g-local');
    if (g === 'move') w.move(m, F, 'Autre/f-local');
    if (g === 'delete') w.rm(m, F);
    if (g === 'parent renamed') w.move(m, 'P/S', 'P/S-local');
    if (g === 'parent moved') w.move(m, 'P/S', 'Autre/S-local');
    if (g === 'parent deleted') w.rm(m, 'P/S');
}
function webGesture(w: World, g: Gesture) {
    if (g === 'edit') w.web.write(F, 'edit web');
    if (g === 'rename') w.web.move(F, 'P/S/g-web');
    if (g === 'move') w.web.move(F, 'Autre/f-web');
    if (g === 'delete') w.web.trash(F);
    if (g === 'parent renamed') w.web.move('P/S', 'P/S-web');
    if (g === 'parent moved') w.web.move('P/S', 'Autre/S-web');
    if (g === 'parent deleted') w.web.trash('P/S');
}

const isDelete = (g: Gesture) => g === 'delete' || g === 'parent deleted';
const isMove = (g: Gesture) => g === 'rename' || g === 'move' || g === 'parent renamed' || g === 'parent moved';

/** From docs/design.md, "Conflict rules". An edit is never lost, a move beats a delete. */
function liveAfter(l: Gesture, r: Gesture): string[] {
    const live: string[] = [];
    if (l === 'edit') live.push('edit local');
    if (r === 'edit') live.push('edit web');
    if (!live.length) {
        const deleted = isDelete(l) || isDelete(r);
        // A folder move does not save a file deleted inside it; moving the file itself, or a folder deleted as a whole, does.
        const parentMove = (g: Gesture) => g === 'parent renamed' || g === 'parent moved';
        const saves = (del: Gesture, mv: Gesture) => isDelete(del) && isMove(mv) && !(del === 'delete' && parentMove(mv));
        const moveSaves = saves(l, r) || saves(r, l);
        if (!deleted || moveSaves) live.push(ORIGINAL);
    }
    return live;
}

const inDesign = (l: Gesture, r: Gesture) => {
    if (l === 'none' || r === 'none') return true;
    if (l === 'edit' || r === 'edit') return true;
    return (isMove(l) || isDelete(l)) && (isMove(r) || isDelete(r));
};

describe('conflict matrix', () => {
    for (const l of GESTURES) {
        for (const r of GESTURES) {
            const expected = liveAfter(l, r);
            row(
                {
                    id: `conflict.${l.replace(' ', '-')}.vs.${r.replace(' ', '-')}`,
                    area,
                    gesture: `Here: ${l}. On the web: ${r}`,
                    expected: expected.length ? `Live afterwards: ${expected.join(' + ')}` : 'Gone from both, recoverable from the trash or quarantine',
                    note: inDesign(l, r) ? undefined : 'Policy gap: not in docs/design.md, both contents kept by default.',
                },
                async () => {
                    const w = await seeded();
                    localGesture(w, w.a, l);
                    webGesture(w, r);
                    await w.settle();
                    w.assertConverged();
                    const live = Object.values(w.hub.tree()).filter((c) => c === ORIGINAL || c.startsWith('edit '));
                    expect(live.sort()).toEqual([...expected].sort());
                },
            );
        }
    }
});
