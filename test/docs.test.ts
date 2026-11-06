import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { THIRD_PARTY_NOTICE } from '../src/names';

const repo = path.join(import.meta.dir, '..');
const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');

describe('docs', () => {
    test('README says what it is, how to install, and what it is not', () => {
        const readme = read('README.md');
        expect(readme).toContain('curl -fsSL');
        for (const text of ['unofficial', THIRD_PARTY_NOTICE, 'beta', 'Linux x64', 'macOS Intel', 'personal, non-commercial', 'end of 2026', 'nucleon-sync uninstall', 'nucleon-sync setup', 'Proton AG', 'backup']) {
            expect(readme).toContain(text);
        }
        expect(readme.split('\n').length).toBeLessThan(150);
    });

    test('the install command is the short address, served from the website', () => {
        const readme = read('README.md');
        expect(/curl -fsSL (\S+) \| sh/.exec(readme)?.[1]).toBe('https://steph-ben.github.io/nucleon-sync/install.sh');
        expect(read('site/index.html')).toContain('https://steph-ben.github.io/nucleon-sync/install.sh');
    });

    test('README explains what is installed and how the SDK is used', () => {
        const readme = read('README.md');
        for (const text of ['Proton Drive SDK', 'state.sqlite', '~/.local/share/nucleon-sync/app', 'system keyring', 'no crypto of its own']) expect(readme).toContain(text);
    });

    test('README says where deleted files can be recovered', () => {
        const readme = read('README.md');
        expect(readme).toContain('A file you delete on your computer goes to the Proton trash');
        expect(readme).toContain('A file deleted or replaced on the Drive is kept in `~/.local/share/nucleon-sync/quarantine`');
        expect(readme).toContain('--purge-data`, which also deletes the quarantine and your saved sign-in');
    });

    test('README development steps patch the crypto package', () => {
        expect(read('README.md')).toContain('bash scripts/patch-crypto.sh');
    });

    test('LICENSE is MIT with the copyright line', () => {
        const license = read('LICENSE');
        expect(license).toContain('MIT License');
        expect(license).toContain('steph-ben');
    });

    test('images are our own assets or badges: no Proton logo', () => {
        const readme = read('README.md');
        const sources = [...readme.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
        expect(sources.length).toBeGreaterThan(0);
        for (const source of sources) expect(source.startsWith('assets/') || source.startsWith('https://img.shields.io/')).toBe(true);
        expect(read('assets/logo.svg').toLowerCase()).not.toContain('#6d4aff');
    });

    test('the migration guides exist and the old docs are gone', () => {
        const fromOld = read('docs/migrating-from-proton-sync.md');
        for (const text of ['nucleon-sync migrate', 'PROTON_SYNC_HOME', 'PROTON_SYNC_CONFIG', '.proton-sync-swap-', 'Next, run `nucleon-sync setup`', 'on the Drive']) {
            expect(fromOld).toContain(text);
        }
        expect(fs.existsSync(path.join(repo, 'docs/migrating-from-rclone.md'))).toBe(false);
        expect(fs.existsSync(path.join(repo, 'docs/linux-install.md'))).toBe(false);
        expect(fs.existsSync(path.join(repo, 'docs/migration.md'))).toBe(false);
    });
});
