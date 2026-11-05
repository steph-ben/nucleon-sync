import { describe, expect } from 'bun:test';
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { detectCaseInsensitive } from '../../src/adapters/local';
import { row } from '../lib/catalog';
import { world } from '../lib/world';

const area = 'Names';
const NFD = 'Été.txt';
const NFC = 'Été.txt';

async function fsIsCaseInsensitive() {
    const d = mkdtempSync(path.join(tmpdir(), 'proton-sync-case-'));
    try {
        return await detectCaseInsensitive(d);
    } finally {
        rmSync(d, { recursive: true, force: true });
    }
}

describe('names', () => {
    for (const [id, name] of [
        ['nfc', NFC],
        ['nfd', NFD],
        ['emoji', '📷 vacances 🏖️.jpg'],
        ['spaces', '  deux  espaces .txt'],
        ['quotes', `l'été "2024" (copie) [1] #2 & co.txt`],
        ['backslash', 'avant\\après.txt'],
        ['long', `${'é'.repeat(100)}${'a'.repeat(51)}`],
    ] as const) {
        row({ id: `name.${id}`, area, gesture: `A file named: ${name.slice(0, 40)}`, expected: 'Same single file everywhere' }, async () => {
            const w = world();
            w.write(w.a, `Dossier/${name}`, id);
            await w.settle();
            w.assertConverged();
            expect(Object.keys(w.hub.tree())).toHaveLength(2);
        });
    }

    row({ id: 'name.nfd-pairs-with-nfc', area, gesture: 'Same name in NFD on the Mac and NFC on the Drive at first sync', expected: 'Paired as one file, no duplicate' }, async () => {
        const w = world();
        w.web.write(NFC, 'pareil');
        w.write(w.a, NFD, 'pareil');
        await w.settle(w.a);
        expect(Object.keys(w.hub.tree())).toHaveLength(1);
        expect(readdirSync(w.a.root).filter((n) => !n.startsWith('.'))).toHaveLength(1);
    });

    row({ id: 'name.nfd-rename-keeps-node', area, gesture: 'Accented file on the Mac is edited after sync', expected: 'New revision, no delete and re-create' }, async () => {
        const w = world();
        w.write(w.a, NFD, 'un');
        await w.settle();
        const id = w.web.node(NFC).id;
        w.write(w.a, NFD, 'deux');
        await w.settle();
        w.assertConverged();
        expect(w.web.node(NFC).id).toBe(id);
    });

    row({ id: 'name.case-only-rename', area, gesture: 'Rename changing only the case: photo.jpg to Photo.jpg', expected: 'One rename everywhere, no loss' }, async () => {
        const w = world({ caseInsensitive: await fsIsCaseInsensitive() });
        w.write(w.a, 'photo.jpg', 'x');
        await w.settle();
        const id = w.web.node('photo.jpg').id;
        renameSync(w.a.abs('photo.jpg'), w.a.abs('Photo.jpg'));
        await w.settle();
        w.assertConverged();
        expect(w.web.node('Photo.jpg').id).toBe(id);
    });

    row({ id: 'name.case-collision', area, gesture: 'Photo.jpg and photo.jpg both on the Drive, reaching a case-insensitive Mac', expected: 'One is downloaded, the other stays on the Drive with a warning. Nothing is lost', status: 'limit', note: 'The second file is not on the Mac until one is renamed. It stays safe on the Drive.' }, async () => {
        const w = world({ caseInsensitive: true });
        w.web.write('Photo.jpg', 'une');
        w.web.write('photo.jpg', 'deux');
        const r = await w.a.engine.cycle();
        expect(r.errors).toEqual([]);
        expect(r.plan.warnings.join()).toContain('name collision');
        await w.settle(w.a);
        expect(Object.keys(w.hub.tree()).sort()).toEqual(['Photo.jpg', 'photo.jpg']);
    });

    row({ id: 'name.too-long-from-drive', area, gesture: 'A name on the Drive too long for the local disk', expected: 'Reported, every other file still syncs, and deletions are not blocked forever', status: 'limit', note: 'That one file stays Drive-only until renamed.' }, async () => {
        const w = world();
        w.web.write('é'.repeat(300), 'long');
        w.web.write('normal.txt', 'ok');
        w.web.write('a-supprimer.txt', 'sup');
        const r = await w.a.engine.cycle();
        expect(r.errors.join()).toMatch(/ENAMETOOLONG|too long/i);
        expect(w.exists(w.a, 'normal.txt')).toBe(true);
        expect(Object.keys(w.hub.tree())).toHaveLength(3);
    });

    row({ id: 'name.traversal-from-drive', area, gesture: 'A hostile name on the Drive: dot-dot and backslash', expected: 'Nothing is written outside the synced folder, the sync does not stop' }, async () => {
        const w = world();
        w.web.write('..\\evil.txt', 'evil');
        w.web.write('normal.txt', 'ok');
        await w.a.engine.cycle();
        expect(readdirSync(path.dirname(w.a.root))).not.toContain('evil.txt');
        expect(w.exists(w.a, 'normal.txt')).toBe(true);
    });
});
