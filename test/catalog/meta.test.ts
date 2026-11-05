import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

test('no catalogue test is skipped or isolated', () => {
    const dir = path.join(import.meta.dir);
    for (const f of readdirSync(dir)) {
        if (f === 'meta.test.ts') continue;
        expect(readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/\.(skip|todo|only)\(/);
    }
});
