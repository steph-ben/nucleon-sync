import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_VERSION, RELEASE_VERSION, VERSION } from '../src/names';

const repo = path.join(import.meta.dir, '..');
const dist = path.join(repo, 'dist');
const archive = path.join(dist, `nucleon-sync-${VERSION}.tar.gz`);
const MAX_ARCHIVE_BYTES = 15 * 1024 * 1024;

// Builds once, with the integration tests skipped (they take longer and run in build-release.sh itself).
beforeAll(() => {
    const build = Bun.spawnSync(['bash', 'scripts/build-release.sh', VERSION], { cwd: repo, env: { ...process.env, SKIP_BUNDLE_TESTS: '1' }, stderr: 'pipe' });
    if (build.exitCode !== 0) throw new Error(`build-release.sh failed: ${build.stderr.toString()}`);
}, 120_000);

describe('release bundle', () => {
    test('the bundle starts and reports its version without node_modules', () => {
        const emptyCwd = mkdtempSync(path.join(tmpdir(), 'bundle-cwd-'));
        const run = Bun.spawnSync([process.execPath, path.join(dist, 'nucleon-sync.js'), 'version'], { cwd: emptyCwd, stderr: 'pipe' });
        expect(run.stderr.toString()).toBe('');
        expect(run.stdout.toString().trim()).toBe(APP_VERSION);
    });

    test('the archive holds only what is needed', () => {
        const listing = Bun.spawnSync(['tar', '-tzf', archive]).stdout.toString().split('\n').filter(Boolean).map((e) => e.replace(/^\.\//, ''));
        for (const needed of ['nucleon-sync.js', 'bin/nucleon-sync', 'LICENSE', 'THIRD-PARTY-NOTICES', 'VERSION']) expect(listing).toContain(needed);
        expect(listing.some((e) => e.startsWith('deploy/'))).toBe(true);
        const allowed = (e: string) => ['nucleon-sync.js', 'LICENSE', 'THIRD-PARTY-NOTICES', 'VERSION', 'bin/nucleon-sync'].includes(e) || e === 'bin/' || e === 'deploy/' || e.startsWith('deploy/');
        expect(listing.filter((e) => !allowed(e))).toEqual([]);
        expect(statSync(archive).size).toBeLessThan(MAX_ARCHIVE_BYTES);
    });

    test('the notices hold the license texts of what the bundle contains', () => {
        const notices = Bun.spawnSync(['tar', '-xzOf', archive, 'THIRD-PARTY-NOTICES']).stdout.toString();
        for (const name of ['@protontech/openpgp', '@protontech/crypto', 'Proton Drive SDK', 'ky', 'ttag', '@sentry/core', '@noble/hashes', 'bcryptjs', '@protontech/jsmimeparser']) expect(notices).toContain(`${name} `);
        expect(notices).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
        expect(notices).toContain('LGPL-3.0');
        expect(notices).toContain('ISC');
        expect(notices).toContain('Proton AG');
    });

    test('a bundled package without a license text fails the notices', () => {
        const folder = mkdtempSync(path.join(tmpdir(), 'notices-'));
        const meta = path.join(folder, 'meta.json');
        writeFileSync(meta, JSON.stringify({ inputs: { 'node_modules/no-such-package/index.js': {} } }));
        const r = Bun.spawnSync([process.execPath, 'scripts/third-party-notices.ts', meta], { cwd: repo, stderr: 'pipe' });
        expect(r.exitCode).toBe(1);
        expect(r.stderr.toString()).toContain('no-such-package');
    });

    test('the unpacked bundle finds its deploy folder and starts the SDK', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'bundle-home-'));
        const version = path.join(home, 'version');
        const data = path.join(home, 'data');
        const shims = path.join(home, 'shims');
        for (const folder of [version, data, shims, path.join(home, '.local/bin'), path.join(home, 'Proton')]) mkdirSync(folder, { recursive: true });
        Bun.spawnSync(['tar', '-xzf', archive, '-C', version]);
        const env = { PATH: `${shims}:${process.env.PATH}`, HOME: home, NUCLEON_SYNC_HOME: data, PROTON_DRIVE_CREDENTIALS_STORE: 'unsafe_file' };
        writeFileSync(path.join(data, 'config.json'), JSON.stringify({ localRoot: path.join(home, 'Proton'), remote: 'root', allowDriveRoot: true, deviceName: 'x', maxDeletes: 20 }));
        const bundle = path.join(version, 'nucleon-sync.js');

        // Reaches the sign-in check, so the SDK loaded from the bundle alone.
        const plan = Bun.spawnSync([process.execPath, bundle, 'plan'], { cwd: home, env, stderr: 'pipe' });
        expect(plan.stderr.toString()).toContain('not logged in');

        for (const tool of ['systemctl', 'launchctl']) writeFileSync(path.join(shims, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(path.join(home, '.local/bin/nucleon-sync'), '');
        const setup = Bun.spawnSync([process.execPath, bundle, 'setup'], { cwd: home, env, stdin: Buffer.from('y\n'), stderr: 'pipe' });
        expect(setup.stderr.toString()).toBe('');
        const service = process.platform === 'darwin' ? 'Library/LaunchAgents/org.nucleonsync.daemon.plist' : '.config/systemd/user/nucleon-sync.service';
        expect(existsSync(path.join(home, service))).toBe(true);
        rmSync(home, { recursive: true, force: true });
    }, 30_000);

    test('SHA256SUMS lists the archive', async () => {
        const sums = await Bun.file(path.join(dist, 'SHA256SUMS')).text();
        expect(sums).toContain(`nucleon-sync-${VERSION}.tar.gz`);
    });

    test('install.sh is stamped with the release, the archive name and the checksum', async () => {
        const script = await Bun.file(path.join(dist, 'install.sh')).text();
        const archiveSha = (await Bun.file(path.join(dist, 'SHA256SUMS')).text()).split(' ')[0];
        expect(script).toContain(`VERSION="${VERSION}"`);
        expect(script).toContain(`RELEASE="${RELEASE_VERSION}"`);
        expect(script).toContain(`ARCHIVE_SHA256="${archiveSha}"`);
        expect(script).toContain('/download/v$RELEASE}');
        expect(script).not.toMatch(/@[A-Z_0-9]+@/);
    });

    test('building a version that differs from src/names.ts fails', () => {
        const build = Bun.spawnSync(['bash', 'scripts/build-release.sh', '9.9.9'], { cwd: repo, env: { ...process.env, SKIP_BUNDLE_TESTS: '1' }, stderr: 'pipe' });
        expect(build.exitCode).toBe(1);
        expect(build.stderr.toString()).toContain('src/names.ts');
    });

    test('building from a tag that is not v<release> fails', () => {
        const build = Bun.spawnSync(['bash', 'scripts/build-release.sh', VERSION, 'v9.9.9-beta'], { cwd: repo, env: { ...process.env, SKIP_BUNDLE_TESTS: '1' }, stderr: 'pipe' });
        expect(build.exitCode).toBe(1);
        expect(build.stderr.toString()).toContain(`v${RELEASE_VERSION}`);
    });
});
