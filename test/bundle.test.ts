import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_VERSION, VERSION } from '../src/names';

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
        for (const needed of ['nucleon-sync.js', 'bin/nucleon-sync', 'LICENSE', 'VERSION']) expect(listing).toContain(needed);
        expect(listing.some((e) => e.startsWith('deploy/'))).toBe(true);
        const allowed = (e: string) => ['nucleon-sync.js', 'LICENSE', 'VERSION', 'bin/nucleon-sync'].includes(e) || e === 'bin/' || e === 'deploy/' || e.startsWith('deploy/');
        expect(listing.filter((e) => !allowed(e))).toEqual([]);
        expect(statSync(archive).size).toBeLessThan(MAX_ARCHIVE_BYTES);
    });

    test('SHA256SUMS lists the archive', async () => {
        const sums = await Bun.file(path.join(dist, 'SHA256SUMS')).text();
        expect(sums).toContain(`nucleon-sync-${VERSION}.tar.gz`);
    });

    test('install.sh is stamped with this version and the archive checksum', async () => {
        const script = await Bun.file(path.join(dist, 'install.sh')).text();
        const archiveSha = (await Bun.file(path.join(dist, 'SHA256SUMS')).text()).split(' ')[0];
        expect(script).toContain(`VERSION="${VERSION}"`);
        expect(script).toContain(`ARCHIVE_SHA256="${archiveSha}"`);
        expect(script).not.toMatch(/@[A-Z_0-9]+@/);
    });

    test('building a version that differs from src/names.ts fails', () => {
        const build = Bun.spawnSync(['bash', 'scripts/build-release.sh', '9.9.9'], { cwd: repo, env: { ...process.env, SKIP_BUNDLE_TESTS: '1' }, stderr: 'pipe' });
        expect(build.exitCode).toBe(1);
        expect(build.stderr.toString()).toContain('src/names.ts');
    });

    // Last, because it builds again. The tag v0.2.0-beta differs from the version 0.2.0.
    test('install.sh downloads from the release tag, not from v<version>', async () => {
        const build = Bun.spawnSync(['bash', 'scripts/build-release.sh', VERSION, `v${VERSION}-beta`], { cwd: repo, env: { ...process.env, SKIP_BUNDLE_TESTS: '1' }, stderr: 'pipe' });
        expect(build.exitCode).toBe(0);
        const script = await Bun.file(path.join(dist, 'install.sh')).text();
        expect(script).toContain(`/download/$TAG}`);
        expect(script).toContain(`TAG="v${VERSION}-beta"`);
        expect(script).toContain(`VERSION="${VERSION}"`);
    });
});
