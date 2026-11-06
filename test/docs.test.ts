import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { THIRD_PARTY_NOTICE } from '../src/names';

const repo = path.join(import.meta.dir, '..');
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');

describe('docs', () => {
    test('README says what it is, how to install, and what it is not', () => {
        const readme = read('README.md');
        const installUrl = /https:\/\/github\.com\/steph-ben\/nucleon-sync\/releases\/(latest\/download|download\/v[^/]+)\/install\.sh/;
        expect(readme).toMatch(installUrl);
        expect(readme).toContain('curl -fsSL');
        for (const text of ['unofficial', THIRD_PARTY_NOTICE, 'beta', 'Linux x64', 'macOS Intel', 'personal, non-commercial', 'end of 2026', 'nucleon-sync uninstall', 'nucleon-sync setup', 'Proton AG', 'backup']) {
            expect(readme).toContain(text);
        }
        expect(readme.split('\n').length).toBeLessThan(120);
    });

    test('README says where deleted files can be recovered', () => {
        const readme = read('README.md');
        expect(readme).toContain('A file you delete on your computer goes to the Proton trash');
        expect(readme).toContain('A file deleted or replaced on the Drive is kept in `~/.local/share/nucleon-sync/quarantine`');
        expect(readme).toContain('--purge-data`, which also deletes the quarantine');
    });

    test('LICENSE is MIT with the copyright line', () => {
        const license = read('LICENSE');
        expect(license).toContain('MIT License');
        expect(license).toContain('steph-ben');
    });

    test('README has no Proton logo or image', () => {
        const readme = read('README.md');
        expect(readme).not.toMatch(/<img|!\[/i);
        expect(readme).not.toMatch(/\blogos?\b/i);
    });

    test('the migration guides exist and the old docs are gone', () => {
        const fromOld = read('docs/migrating-from-proton-sync.md');
        for (const text of ['nucleon-sync migrate', 'PROTON_SYNC_HOME', 'PROTON_SYNC_CONFIG', '.proton-sync-swap-']) {
            expect(fromOld).toContain(text);
        }
        const fromRclone = read('docs/migrating-from-rclone.md');
        for (const text of ['--resync', 'plan', 'link', 'setup --reset', 'scratch folder', 'type `yes`', 'launchctl disable']) expect(fromRclone).toContain(text);
        expect(fs.existsSync(path.join(repo, 'docs/linux-install.md'))).toBe(false);
        expect(fs.existsSync(path.join(repo, 'docs/migration.md'))).toBe(false);
    });
});
