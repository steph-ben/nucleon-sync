import { describe, expect } from 'bun:test';

import { row } from '../lib/catalog';
import { type Machine, world } from '../lib/world';

type World = ReturnType<typeof world>;
type Origin = 'this machine' | 'other machine' | 'web';
type ObjectKind = 'empty file' | 'file' | 'empty folder' | 'nested folder';

const ORIGINS: Origin[] = ['this machine', 'other machine', 'web'];
const OBJECTS: ObjectKind[] = ['empty file', 'file', 'empty folder', 'nested folder'];
const X = 'Albums/x';

async function seeded(kind: ObjectKind) {
    const w = world();
    if (kind === 'empty file') w.write(w.a, X, '');
    if (kind === 'file') w.write(w.a, X, 'contenu');
    if (kind === 'empty folder') w.mkdir(w.a, X);
    if (kind === 'nested folder') {
        w.write(w.a, `${X}/2024/ete/plage.jpg`, 'plage');
        w.write(w.a, `${X}/2024/hiver.jpg`, 'hiver');
    }
    w.mkdir(w.a, 'Autre');
    await w.settle();
    return w;
}

const on = (w: World, o: Origin): Machine | undefined => (o === 'this machine' ? w.a : o === 'other machine' ? w.b : undefined);

function gesture(w: World, o: Origin) {
    const m = on(w, o);
    return {
        add(kind: ObjectKind, rel: string) {
            if (kind === 'empty folder' || kind === 'nested folder') {
                if (m) w.mkdir(m, rel);
                else w.web.mkdir(rel);
                if (kind === 'nested folder') {
                    if (m) w.write(m, `${rel}/sous/photo.jpg`, 'photo');
                    else {
                        w.web.mkdir(`${rel}/sous`);
                        w.web.write(`${rel}/sous/photo.jpg`, 'photo');
                    }
                }
            } else if (m) w.write(m, rel, kind === 'file' ? 'nouveau' : '');
            else w.web.write(rel, kind === 'file' ? 'nouveau' : '');
        },
        edit: (content: string) => (m ? w.write(m, X, content) : w.web.write(X, content)),
        move: (to: string) => (m ? w.move(m, X, to) : w.web.move(X, to)),
        copy: (to: string) => (m ? w.copy(m, X, to) : w.web.copy(X, to)),
        delete: () => (m ? w.rm(m, X) : w.web.trash(X)),
    };
}

describe('everyday gestures', () => {
    for (const kind of OBJECTS) {
        for (const origin of ORIGINS) {
            const id = (g: string) => `gesture.${g}.${kind.replace(' ', '-')}.${origin.replace(' ', '-')}`;
            const row_ = (g: string, text: string, expected: string, fn: () => Promise<void>) => row({ id: id(g), area: 'Everyday gestures', gesture: `${text} (${kind}, from ${origin})`, expected }, fn);

            row_('add', 'Add', 'It appears everywhere', async () => {
                const w = await seeded('empty folder');
                gesture(w, origin).add(kind, 'Autre/nouveau');
                await w.settle();
                w.assertConverged();
                expect(w.exists(w.a, 'Autre/nouveau') && w.exists(w.b, 'Autre/nouveau')).toBe(true);
            });

            row_('rename', 'Rename', 'One rename everywhere, no transfer, no deletion', async () => {
                const w = await seeded(kind);
                const uid = w.web.node(X).id;
                gesture(w, origin).move('Albums/y');
                await w.settle();
                w.assertConverged();
                expect(w.web.node('Albums/y').id).toBe(uid);
                expect(w.exists(w.a, X) || w.exists(w.b, X)).toBe(false);
            });

            row_('move', 'Move to another folder', 'One move everywhere, no transfer, no deletion', async () => {
                const w = await seeded(kind);
                const uid = w.web.node(X).id;
                gesture(w, origin).move('Autre/x');
                await w.settle();
                w.assertConverged();
                expect(w.web.node('Autre/x').id).toBe(uid);
            });

            row_('copy', 'Copy', 'Original and copy exist everywhere', async () => {
                const w = await seeded(kind);
                gesture(w, origin).copy('Autre/copie');
                await w.settle();
                w.assertConverged();
                expect(w.exists(w.a, X) && w.exists(w.b, 'Autre/copie')).toBe(true);
            });

            row_('delete', 'Delete', 'Gone everywhere, recoverable from the trash or quarantine', async () => {
                const w = await seeded(kind);
                gesture(w, origin).delete();
                await w.settle();
                w.assertConverged();
                expect(w.exists(w.a, X) || w.exists(w.b, X)).toBe(false);
            });

            row_('restore', 'Delete, then restore from the Drive trash', 'It comes back everywhere', async () => {
                const w = await seeded(kind);
                const uid = w.web.node(X).id;
                gesture(w, origin).delete();
                await w.settle();
                w.web.restore(uid);
                await w.settle();
                w.assertConverged();
                expect(w.exists(w.a, X) && w.exists(w.b, X)).toBe(true);
            });

            if (kind === 'file' || kind === 'empty file') {
                row_('edit', 'Edit', 'New version everywhere, old version in the history', async () => {
                    const w = await seeded(kind);
                    const uid = w.web.node(X).id;
                    gesture(w, origin).edit('version 2');
                    await w.settle();
                    w.assertConverged();
                    expect(w.web.node(X).id).toBe(uid);
                    expect(w.hub.nodes.get(uid)!.revisions).toContain('version 2');
                });
            }
        }
    }
});
