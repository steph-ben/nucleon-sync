import { describe, expect } from 'bun:test';
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { sha1File } from '../../src/adapters/local';
import { row } from '../lib/catalog';
import { type DriveOp, machine, settle, world } from '../lib/world';
import { Hub } from '../sim';

const area = 'Photos and music';
const BIG = 5000;
const MB = 1024 * 1024;

function library(w: ReturnType<typeof world>, n: number, dir = 'Photos/2024') {
    mkdirSync(w.a.abs(dir), { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(w.a.abs(`${dir}/IMG_${i}.jpg`), `photo ${i}`);
}
function counter(w: ReturnType<typeof world>) {
    const ops: Partial<Record<DriveOp, number>> = {};
    for (const m of [w.a, w.b]) m.drive.before = (op) => void (ops[op] = (ops[op] ?? 0) + 1);
    return ops;
}

describe('photos and music', () => {
    row({ id: 'media.import-thousands', area, gesture: `Import ${BIG} photos at once`, expected: 'All of them reach the Drive and the other machine' }, async () => {
        const w = world();
        library(w, BIG);
        await w.settle();
        expect(Object.keys(w.hub.tree())).toHaveLength(BIG + 2);
        expect(readFileSync(w.b.abs('Photos/2024/IMG_4999.jpg'), 'utf8')).toBe('photo 4999');
    }, 120000);

    row({ id: 'media.rename-album', area, gesture: `Rename an album of ${BIG} photos`, expected: 'A single operation, no transfer' }, async () => {
        const w = world();
        library(w, BIG);
        await w.settle();
        const ops = counter(w);
        renameSync(w.a.abs('Photos/2024'), w.a.abs('Photos/Vacances'));
        await w.settle();
        expect(ops.move).toBe(1);
        expect(ops.upload ?? 0).toBe(0);
        expect(ops.download ?? 0).toBe(0);
        expect(ops.trash ?? 0).toBe(0);
        expect(readFileSync(w.b.abs('Photos/Vacances/IMG_1.jpg'), 'utf8')).toBe('photo 1');
    }, 120000);

    row({ id: 'media.reorganise', area, gesture: 'Reorganise a library: albums moved, renamed and nested at once', expected: 'Every photo keeps its Drive identity' }, async () => {
        const w = world();
        library(w, 50, 'Photos/2023');
        library(w, 50, 'Photos/2024');
        await w.settle();
        const id = w.web.node('Photos/2023/IMG_7.jpg').id;
        mkdirSync(w.a.abs('Archives'));
        renameSync(w.a.abs('Photos/2023'), w.a.abs('Archives/Anciennes'));
        renameSync(w.a.abs('Photos/2024'), w.a.abs('Récent'));
        await w.settle();
        w.assertConverged();
        expect(w.web.node('Archives/Anciennes/IMG_7.jpg').id).toBe(id);
    });

    row({ id: 'media.delete-album', area, gesture: 'Delete an album of 30 photos on purpose', expected: 'Held until approved, then trash and quarantine' }, async () => {
        const w = world();
        library(w, 30);
        await w.settle();
        w.rm(w.a, 'Photos/2024');
        const held = await w.a.engine.cycle();
        expect(held.plan.heldReason).toBe('limit');
        await w.b.engine.cycle();
        expect(w.exists(w.b, 'Photos/2024/IMG_0.jpg')).toBe(true);
        await w.a.engine.cycle(true);
        await w.b.engine.cycle(true);
        await w.settle();
        expect(w.exists(w.b, 'Photos/2024/IMG_0.jpg')).toBe(false);
        w.assertConverged();
    });

    row({ id: 'media.tag-edit-same-size', area, gesture: 'Music tagger edits a file: same size, modification date preserved', expected: 'The edit still reaches the Drive' }, async () => {
        const w = world();
        const f = w.a.abs('Musique/titre.mp3');
        w.write(w.a, 'Musique/titre.mp3', 'tag=ancien');
        await w.settle();
        const before = statSync(f);
        writeFileSync(f, 'tag=nouvel');
        utimesSync(f, before.atime, before.mtime);
        await w.settle();
        expect(readFileSync(w.b.abs('Musique/titre.mp3'), 'utf8')).toBe('tag=nouvel');
    });

    row({ id: 'media.large-hash-streamed', area, gesture: 'Reading a 200 MB file for its hash', expected: 'Streamed: memory stays well below the file size' }, async () => {
        const w = world();
        const f = w.a.abs('video.mov');
        const fd = openSync(f, 'w');
        ftruncateSync(fd, 200 * MB);
        closeSync(fd);
        Bun.gc(true);
        const before = process.memoryUsage().rss;
        await sha1File(f);
        expect(process.memoryUsage().rss - before).toBeLessThan(100 * MB);
    }, 60000);

    row({ id: 'media.large-download-interrupted', area, gesture: 'Download of a large file cut half-way', expected: 'The old version stays intact, no temporary file left behind' }, async () => {
        const hub = new Hub();
        const m = machine('A', hub);
        const f = m.abs('film.mov');
        writeFileSync(f, 'ancienne version');
        await expect(
            m.local.writeFile('film2.mov', undefined, Date.now(), async (tmp) => {
                const out = createWriteStream(tmp);
                await pipeline(createReadStream(f), out);
                throw new Error('connection lost');
            }),
        ).rejects.toThrow('connection lost');
        expect(readFileSync(f, 'utf8')).toBe('ancienne version');
        await settle(m);
        expect(Object.keys(hub.tree())).toEqual(['film.mov']);
    });
});
