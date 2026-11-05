import { describe, expect } from 'bun:test';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import { row } from '../lib/catalog';
import { type Machine, tree, world } from '../lib/world';

const area = 'Notes';
const N = 'Notes/journal.md';
const atomicSave = (w: ReturnType<typeof world>, m: Machine, rel: string, content: string) => {
    const tmp = m.abs(`${rel}.tmp`);
    writeFileSync(tmp, content);
    renameSync(tmp, m.abs(rel));
    w.ledger.saw(content);
};

describe('notes', () => {
    row({ id: 'notes.atomic-saves', area, gesture: 'Note saved 10 times by an editor using atomic saves', expected: 'One file, every synced version in its history, never a delete' }, async () => {
        const w = world();
        w.write(w.a, N, 'v0');
        await w.settle();
        const id = w.web.node(N).id;
        for (let i = 1; i <= 10; i++) {
            atomicSave(w, w.a, N, `v${i}`);
            await w.a.engine.cycle();
        }
        await w.settle();
        w.assertConverged();
        expect(w.web.node(N).id).toBe(id);
        expect(w.hub.nodes.get(id)!.revisions).toHaveLength(11);
    });

    row({ id: 'notes.edit-during-upload', area, gesture: 'Note edited while it is being uploaded', expected: 'The latest edit wins and reaches everywhere' }, async () => {
        const w = world();
        w.write(w.a, N, 'v1');
        await w.settle();
        w.write(w.a, N, 'v2');
        w.a.drive.afterRead = () => {
            w.a.drive.afterRead = () => {};
            w.write(w.a, N, 'v3 tapée pendant l envoi');
        };
        await w.settle();
        w.assertConverged();
        expect(tree(w.b.root)[N]).toBe('v3 tapée pendant l envoi');
    });

    row({ id: 'notes.edit-during-download', area, gesture: 'Note edited here while a new version is being downloaded', expected: 'Both versions kept, the local edit is never overwritten' }, async () => {
        const w = world();
        w.write(w.a, N, 'v1');
        await w.settle();
        w.web.write(N, 'version du web');
        w.a.drive.before = (op) => {
            if (op !== 'download') return;
            w.a.drive.before = () => {};
            w.write(w.a, N, 'frappe locale');
        };
        const r = await w.a.engine.cycle();
        expect(r.errors.join()).toContain('modified during download');
        await w.settle();
        w.assertConverged();
        const contents = Object.values(tree(w.a.root));
        expect(contents).toContain('frappe locale');
        expect(contents).toContain('version du web');
    });

    row({ id: 'notes.both-machines', area, gesture: 'Same note edited on both machines before they sync', expected: 'Both versions kept on both machines' }, async () => {
        const w = world();
        w.write(w.a, N, 'v1');
        await w.settle();
        w.write(w.a, N, 'depuis A');
        w.write(w.b, N, 'depuis B');
        await w.settle();
        w.assertConverged();
        expect(Object.values(tree(w.a.root)).sort()).toEqual(['depuis A', 'depuis B']);
    });

    row({ id: 'notes.settings-churn', area, gesture: 'An app settings file rewritten constantly on both machines', expected: 'Converges as soon as it stops, no version lost' }, async () => {
        const w = world();
        const S = '.obsidian/workspace.json';
        w.write(w.a, S, '{"n":0}');
        await w.settle();
        for (let i = 1; i <= 6; i++) {
            w.write(i % 2 ? w.a : w.b, S, `{"n":${i}}`);
            await w.a.engine.cycle();
            await w.b.engine.cycle();
        }
        await w.settle();
        w.assertConverged();
        expect(readFileSync(w.a.abs(S), 'utf8')).toBe(readFileSync(w.b.abs(S), 'utf8'));
    });
});
