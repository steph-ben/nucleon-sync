import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_NAME, APP_VERSION, CHANNEL, VERSION, dataDir } from '../src/names';

const repo = path.join(import.meta.dir, '..');
const OLD_NAME = /proton[-_]?sync/i;

// Test files that name the legacy on purpose.
const LEGACY_ON_PURPOSE = ['test/names.test.ts', 'test/local.test.ts', 'test/journal.test.ts'];
// Folders and files that must no longer carry the old name.
const CHECKED = ['src', 'bin', 'deploy', 'desktop', 'scripts', '.github', 'vendor/proton-sdk/cli/src/credentials', 'test'];
const ALLOWED_FILES = ['src/names.ts', ...LEGACY_ON_PURPOSE];

function listFiles(dir: string): string[] {
    const abs = path.join(repo, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
        if (e.name === '__pycache__' || e.name === 'node_modules') return [];
        const rel = `${dir}/${e.name}`;
        return e.isDirectory() ? listFiles(rel) : [rel];
    });
}

describe('names', () => {
    test('header follows the SDK shape and says what it is', () => {
        expect(APP_VERSION).toMatch(/^external-drive-nucleon_sync@\d+\.\d+\.\d+-(stable|beta|alpha)$/);
        expect(APP_VERSION).not.toMatch(/proton/i);
        expect(APP_VERSION).toBe(`external-drive-nucleon_sync@${VERSION}-${CHANNEL}`);
        expect(APP_NAME).toBe('nucleon-sync');
    });

    test('the data folder: new variable, deprecated alias, default', () => {
        expect(dataDir({ NUCLEON_SYNC_HOME: '/n', PROTON_SYNC_HOME: '/p' }, '/h')).toBe('/n');
        expect(dataDir({ PROTON_SYNC_HOME: '/p' }, '/h')).toBe('/p');
        expect(dataDir({}, '/h')).toBe('/h/.local/share/nucleon-sync');
    });

    test('no source file still uses the old name', () => {
        const offenders: string[] = [];
        for (const dir of CHECKED) {
            for (const file of listFiles(dir)) {
                if (ALLOWED_FILES.includes(file)) continue;
                if (OLD_NAME.test(file) || OLD_NAME.test(fs.readFileSync(path.join(repo, file), 'utf8'))) offenders.push(file);
            }
        }
        expect(offenders).toEqual([]);
    });
});
