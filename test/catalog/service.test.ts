import { describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

import { row } from '../lib/catalog';
import { type DriveOp, tree, world } from '../lib/world';

const area = 'Service failures';

async function seeded() {
    const w = world();
    for (const f of ['Albums/a.jpg', 'Albums/b.jpg', 'Notes/n.md', 'Notes/m.md', 'z.txt']) w.write(w.a, f, `contenu ${f}`);
    await w.settle();
    return w;
}
const trashed = (w: ReturnType<typeof world>) => [...w.hub.nodes.values()].filter((n) => n.trashed).length;
const network = () => new Error('network unreachable');

/** Each kind of operation has a pending change, so a cut on it matters. */
async function busy() {
    const w = await seeded();
    w.write(w.a, 'neuf.txt', 'neuf');
    w.write(w.a, 'z.txt', 'version 2');
    w.mkdir(w.a, 'Dossier neuf');
    w.move(w.a, 'Notes/m.md', 'Albums/m.md');
    w.rm(w.a, 'Notes/n.md');
    w.web.write('du-web.txt', 'web');
    return w;
}

describe('service failures', () => {
    for (const op of ['snapshot', 'mkdir', 'move', 'upload', 'uploadRevision', 'download', 'trash'] as DriveOp[]) {
        row({ id: `service.network-${op}`, area, gesture: `Network cut during ${op}`, expected: 'Nothing lost, the next pass finishes the job' }, async () => {
            const w = await busy();
            w.a.drive.fail(op, network);
            await w.a.engine.cycle().catch(() => {});
            await w.settle();
            w.assertConverged();
        });
    }

    row({ id: 'service.network-down-hours', area, gesture: 'Network down across many passes', expected: 'No pass deletes anything, and it catches up' }, async () => {
        const w = await busy();
        w.a.drive.fail('snapshot', network, 5);
        for (let i = 0; i < 5; i++) await expect(w.a.engine.cycle()).rejects.toThrow('network');
        expect(trashed(w)).toBe(0);
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'service.session-expired', area, gesture: 'The Proton session expires', expected: 'Passes fail loudly, nothing is touched, it resumes after logging in again', note: 'Error modelled from the SDK; not triggered on the real service.' }, async () => {
        const w = await busy();
        const before = JSON.stringify(tree(w.a.root));
        w.a.drive.fail('snapshot', () => new Error('session expired: 401'), 3);
        for (let i = 0; i < 3; i++) await expect(w.a.engine.cycle()).rejects.toThrow('401');
        expect(JSON.stringify(tree(w.a.root))).toBe(before);
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'service.quota-full', area, gesture: 'The Drive quota is full', expected: 'Uploads fail and are reported, nothing is deleted in that pass, they resume when space is back', note: 'Error modelled from the SDK; not triggered on the real service.' }, async () => {
        const w = await busy();
        w.a.drive.fail('upload', () => new Error('storage quota exceeded'), 2);
        w.a.drive.fail('uploadRevision', () => new Error('storage quota exceeded'), 2);
        const r = await w.a.engine.cycle();
        expect(r.errors.join()).toContain('quota');
        expect(r.plan.actions.some((x) => x.t === 'remoteTrash')).toBe(true);
        expect(trashed(w)).toBe(0);
        await w.a.engine.cycle();
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'service.rate-limited', area, gesture: 'Proton rate-limits the client', expected: 'Retried on a later pass, nothing lost', note: 'Error modelled from the SDK; not triggered on the real service.' }, async () => {
        const w = await busy();
        w.a.drive.fail('download', () => new Error('too many requests: 429'), 2);
        await w.a.engine.cycle();
        await w.a.engine.cycle();
        await w.settle();
        w.assertConverged();
    });

    row({ id: 'service.bad-download', area, gesture: 'A downloaded file fails its hash check', expected: 'Refused: the old version stays, it is downloaded again' }, async () => {
        const w = await seeded();
        w.web.write('z.txt', 'bonne version');
        w.a.drive.corruptDownloads = 1;
        const r = await w.a.engine.cycle();
        expect(r.errors.join()).toContain('SHA-1');
        expect(readFileSync(w.a.abs('z.txt'), 'utf8')).toBe('contenu z.txt');
        await w.settle();
        expect(readFileSync(w.a.abs('z.txt'), 'utf8')).toBe('bonne version');
        w.assertConverged();
    });

    row({ id: 'service.no-hash', area, gesture: 'The Drive does not report a hash for a file', expected: 'It is downloaded and stays stable, no loop' }, async () => {
        const w = world();
        w.a.drive.hideHashes = true;
        w.web.write('ancien.txt', 'sans empreinte');
        await w.settle(w.a);
        expect(readFileSync(w.a.abs('ancien.txt'), 'utf8')).toBe('sans empreinte');
        expect((await w.a.engine.cycle()).plan.actions).toEqual([]);
    });

    row({ id: 'service.no-hash-first-run', area, gesture: 'A local file has the same name as a Drive file without a hash, at first sync', expected: 'Both are kept' }, async () => {
        const w = world();
        w.a.drive.hideHashes = true;
        w.web.write('doc.txt', 'version drive');
        w.write(w.a, 'doc.txt', 'version locale');
        await w.settle(w.a);
        const contents = Object.values(tree(w.a.root));
        expect(contents).toContain('version drive');
        expect(contents).toContain('version locale');
    });

    row({ id: 'service.drive-empty', area, gesture: 'The Drive suddenly looks empty', expected: 'Safety stop, nothing removed locally' }, async () => {
        const w = await seeded();
        for (const n of w.hub.nodes.values()) n.trashed = true;
        await expect(w.a.engine.cycle()).rejects.toThrow('empty');
        expect(Object.keys(tree(w.a.root))).toHaveLength(5);
    });
});
