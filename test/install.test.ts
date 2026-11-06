import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dir, '..');
const scriptSource = path.join(repo, 'install/install.sh');
const work = mkdtempSync(path.join(tmpdir(), 'install-test-'));

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (cmd: string[], cwd: string) => {
    const r = Bun.spawnSync(cmd, { cwd });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`);
};

/** A fake release: archive for `version`, a stub bun zip, and the install.sh stamped like build-release.sh does. */
function makeRelease(version: string) {
    const dir = path.join(work, `release-${version}`);
    const stage = path.join(dir, 'stage');
    mkdirSync(path.join(stage, 'bin'), { recursive: true });
    writeFileSync(path.join(stage, 'nucleon-sync.js'), `// ${version}\n`);
    writeFileSync(path.join(stage, 'bin/nucleon-sync'), '#!/bin/sh\necho stub\n', { mode: 0o755 });
    writeFileSync(path.join(stage, 'VERSION'), version);
    const archive = path.join(dir, `nucleon-sync-${version}.tar.gz`);
    run(['tar', '-czf', archive, '-C', stage, 'nucleon-sync.js', 'bin', 'VERSION'], dir);

    const bunDir = path.join(dir, 'bun-linux-x64');
    mkdirSync(bunDir, { recursive: true });
    writeFileSync(path.join(bunDir, 'bun'), '#!/bin/sh\necho 1.4.2\n', { mode: 0o755 });
    const bunZip = path.join(dir, 'bun-linux-x64.zip');
    run(['zip', '-qr', bunZip, 'bun-linux-x64'], dir);

    const stamp = (archiveSha: string) => {
        const text = readFileSync(scriptSource, 'utf8').replaceAll('@VERSION@', version).replaceAll('@TAG@', `v${version}`).replaceAll('@ARCHIVE_SHA256@', archiveSha);
        const file = path.join(dir, `install-${archiveSha.slice(0, 6)}.sh`);
        writeFileSync(file, text);
        return file;
    };
    return { dir, bunZip, script: stamp(sha(archive)), badScript: stamp('0'.repeat(64)) };
}

function install(script: string, home: string, release: { dir: string; bunZip: string }, extra: Record<string, string> = {}) {
    const r = Bun.spawnSync(['sh', script], {
        env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            NUCLEON_BASE_URL: `file://${release.dir}`,
            NUCLEON_BUN_URL: `file://${release.bunZip}`,
            NUCLEON_BUN_SHA256: sha(release.bunZip),
            NUCLEON_UNAME_S: 'Linux',
            NUCLEON_UNAME_M: 'x86_64',
            ...extra,
        },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const newHome = () => mkdtempSync(path.join(work, 'home-'));
const app = (home: string) => path.join(home, '.local/share/nucleon-sync/app');
const link = (home: string) => path.join(home, '.local/bin/nucleon-sync');

let v1: ReturnType<typeof makeRelease>;
let v2: ReturnType<typeof makeRelease>;
beforeAll(() => {
    v1 = makeRelease('1.0.0');
    v2 = makeRelease('2.0.0');
});

describe('install.sh', () => {
    test('a fresh install creates the layout and prints the next step', () => {
        const home = newHome();
        const r = install(v1.script, home, v1);
        expect(r.err).toBe('');
        expect(r.code).toBe(0);
        expect(readlinkSync(path.join(app(home), 'current'))).toBe('versions/1.0.0');
        expect(existsSync(path.join(app(home), 'versions/1.0.0/nucleon-sync.js'))).toBe(true);
        expect(existsSync(path.join(app(home), 'bun/bun'))).toBe(true);
        expect(readlinkSync(link(home))).toBe(path.join(app(home), 'current/bin/nucleon-sync'));
        expect(existsSync(link(home))).toBe(true);
        expect(r.out).toContain('nucleon-sync setup');
        expect(existsSync(path.join(home, '.local/share/nucleon-sync/.tmp')) ? Bun.spawnSync(['ls', path.join(home, '.local/share/nucleon-sync/.tmp')]).stdout.toString() : '').toBe('');
    });

    test('running it twice changes nothing', () => {
        const home = newHome();
        install(v1.script, home, v1);
        const r = install(v1.script, home, v1);
        expect(r.code).toBe(0);
        expect(readlinkSync(path.join(app(home), 'current'))).toBe('versions/1.0.0');
        expect(readlinkSync(link(home))).toBe(path.join(app(home), 'current/bin/nucleon-sync'));
    });

    test('a wrong checksum installs nothing', () => {
        const home = newHome();
        const r = install(v1.badScript, home, v1);
        expect(r.code).toBe(1);
        expect(r.err).toContain('checksum');
        expect(existsSync(path.join(app(home), 'versions'))).toBe(false);
        expect(existsSync(path.join(app(home), 'current'))).toBe(false);
        expect(existsSync(link(home))).toBe(false);
    });

    test('a wrong bun checksum installs nothing', () => {
        const home = newHome();
        const r = install(v1.script, home, v1, { NUCLEON_BUN_SHA256: '0'.repeat(64) });
        expect(r.code).toBe(1);
        expect(existsSync(path.join(app(home), 'current'))).toBe(false);
        expect(existsSync(link(home))).toBe(false);
    });

    test('an interrupted download leaves the previous version working', () => {
        const home = newHome();
        install(v1.script, home, v1);
        const r = install(v2.script, home, v2, { NUCLEON_BASE_URL: `file://${path.join(work, 'missing')}` });
        expect(r.code).toBe(1);
        expect(readlinkSync(path.join(app(home), 'current'))).toBe('versions/1.0.0');
        expect(existsSync(path.join(app(home), 'versions/2.0.0'))).toBe(false);
        expect(existsSync(link(home))).toBe(true);
    });

    test('~/.local/bin missing from PATH prints the exact line to add', () => {
        const r = install(v1.script, newHome(), v1);
        expect(r.out).toContain('export PATH="$HOME/.local/bin:$PATH"');
    });

    test('~/.local/bin already in PATH prints no PATH line', () => {
        const home = newHome();
        const r = install(v1.script, home, v1, { PATH: `${home}/.local/bin:${process.env.PATH}` });
        expect(r.out).not.toContain('export PATH=');
    });

    test('NUCLEON_SWITCH=0 unpacks the version and leaves current and the command alone', () => {
        const home = newHome();
        install(v1.script, home, v1);
        const r = install(v2.script, home, v2, { NUCLEON_SWITCH: '0' });
        expect(r.code).toBe(0);
        expect(existsSync(path.join(app(home), 'versions/2.0.0/bin/nucleon-sync'))).toBe(true);
        expect(readlinkSync(path.join(app(home), 'current'))).toBe('versions/1.0.0');
    });

    test('NUCLEON_SWITCH=0 on a first install creates no current and no command', () => {
        const home = newHome();
        const r = install(v1.script, home, v1, { NUCLEON_SWITCH: '0' });
        expect(r.code).toBe(0);
        expect(existsSync(path.join(app(home), 'versions/1.0.0'))).toBe(true);
        expect(existsSync(path.join(app(home), 'current'))).toBe(false);
        expect(existsSync(link(home))).toBe(false);
    });

    test('an unsupported platform is refused clearly and writes nothing', () => {
        for (const [s, m] of [['FreeBSD', 'amd64'], ['Darwin', 'arm64'], ['Linux', 'aarch64']]) {
            const home = newHome();
            const r = install(v1.script, home, v1, { NUCLEON_UNAME_S: s, NUCLEON_UNAME_M: m });
            expect(r.code).toBe(1);
            expect(r.err).toContain('not supported yet');
            expect(existsSync(path.join(home, '.local'))).toBe(false);
        }
    });

    test('Darwin x86_64 is accepted', () => {
        const home = newHome();
        const darwinZip = path.join(v1.dir, 'bun-darwin-x64.zip');
        run(['cp', v1.bunZip, darwinZip], v1.dir);
        const r = install(v1.script, home, v1, { NUCLEON_UNAME_S: 'Darwin', NUCLEON_UNAME_M: 'x86_64' });
        expect(r.code).toBe(0);
    });

    test('a missing tool is named', () => {
        const emptyBin = mkdtempSync(path.join(work, 'nobin-'));
        const home = newHome();
        const sh = Bun.which('sh') as string;
        const r = Bun.spawnSync([sh, v1.script], { env: { PATH: emptyBin, HOME: home, NUCLEON_UNAME_S: 'Linux', NUCLEON_UNAME_M: 'x86_64' } });
        expect(r.exitCode).toBe(1);
        expect(r.stderr.toString()).toContain('curl');
        expect(existsSync(path.join(home, '.local'))).toBe(false);
    });

    test('a failed move into versions/ leaves current on the previous version and prints no success', () => {
        const home = newHome();
        install(v1.script, home, v1);
        const versions = path.join(app(home), 'versions');
        chmodSync(versions, 0o555);
        try {
            const r = install(v2.script, home, v2);
            expect(r.code).toBe(1);
            expect(r.out).not.toContain('is installed');
            expect(readlinkSync(path.join(app(home), 'current'))).toBe('versions/1.0.0');
        } finally {
            chmodSync(versions, 0o755);
        }
    });

    test('a bun that cannot start installs nothing', () => {
        const home = newHome();
        const badDir = mkdtempSync(path.join(work, 'badbun-'));
        mkdirSync(path.join(badDir, 'bun-linux-x64'));
        writeFileSync(path.join(badDir, 'bun-linux-x64/bun'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        const zip = path.join(badDir, 'bun-linux-x64.zip');
        run(['zip', '-qr', zip, 'bun-linux-x64'], badDir);
        const r = install(v1.script, home, v1, { NUCLEON_BUN_URL: `file://${zip}`, NUCLEON_BUN_SHA256: sha(zip) });
        expect(r.code).toBe(1);
        expect(r.err).toContain('does not start');
        expect(existsSync(path.join(app(home), 'bun'))).toBe(false);
        expect(existsSync(path.join(app(home), 'current'))).toBe(false);
        expect(existsSync(link(home))).toBe(false);
    });

    test('running as root is refused (id stub)', () => {
        const home = newHome();
        const stubDir = mkdtempSync(path.join(work, 'idstub-'));
        writeFileSync(path.join(stubDir, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
        const r = install(v1.script, home, v1, { PATH: `${stubDir}:${process.env.PATH}` });
        expect(r.code).toBe(1);
        expect(r.err).toContain('root');
        expect(existsSync(path.join(home, '.local'))).toBe(false);
    });

    test('the script never calls sudo and runs everything inside main', () => {
        const source = readFileSync(scriptSource, 'utf8');
        expect(source).not.toContain('sudo');
        expect(source.trimEnd().split('\n').pop()).toBe('main "$@"');
        expect(lstatSync(scriptSource).isFile()).toBe(true);
    });
});
