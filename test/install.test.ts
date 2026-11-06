import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runUpdate } from '../src/desktop/update';
import { releaseAppVersion } from '../src/names';

const repo = path.join(import.meta.dir, '..');
const scriptSource = path.join(repo, 'install/install.sh');
const work = mkdtempSync(path.join(tmpdir(), 'install-test-'));

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (cmd: string[], cwd: string) => {
    const r = Bun.spawnSync(cmd, { cwd });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`);
};

/** A fake release: archive for `release`, a stub bun zip, and the install.sh stamped like build-release.sh does. */
function makeRelease(release: string) {
    const version = release.split('-')[0]!;
    const dir = path.join(work, `release-${release}`);
    const stage = path.join(dir, 'stage');
    mkdirSync(path.join(stage, 'bin'), { recursive: true });
    writeFileSync(path.join(stage, 'nucleon-sync.js'), `// ${release}\n`);
    writeFileSync(path.join(stage, 'bin/nucleon-sync'), `#!/bin/sh\necho ${releaseAppVersion(release)}\n`, { mode: 0o755 });
    writeFileSync(path.join(stage, 'VERSION'), release);
    const archive = path.join(dir, `nucleon-sync-${version}.tar.gz`);
    run(['tar', '-czf', archive, '-C', stage, 'nucleon-sync.js', 'bin', 'VERSION'], dir);

    const bunDir = path.join(dir, 'bun-linux-x64');
    mkdirSync(bunDir, { recursive: true });
    writeFileSync(path.join(bunDir, 'bun'), '#!/bin/sh\necho 1.4.2\n', { mode: 0o755 });
    const bunZip = path.join(dir, 'bun-linux-x64.zip');
    run(['zip', '-qr', bunZip, 'bun-linux-x64'], dir);

    const stamp = (archiveSha: string) => {
        const text = readFileSync(scriptSource, 'utf8').replaceAll('@VERSION@', version).replaceAll('@RELEASE@', release).replaceAll('@ARCHIVE_SHA256@', archiveSha);
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
            NUCLEON_NO_SETUP: '1',
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

    test('the setup assistant starts by itself, reading the terminal', () => {
        const release = makeRelease('7.0.0');
        const home = mkdtempSync(path.join(work, 'home-'));
        const tty = path.join(work, 'fake-tty');
        writeFileSync(tty, 'answer from the terminal\n');
        // The stub command prints the version whatever its arguments.
        const r = install(release.script, home, release, { NUCLEON_NO_SETUP: '', NUCLEON_TTY: tty });
        expect(r.code).toBe(0);
        expect(r.out).toContain(releaseAppVersion('7.0.0'));
        expect(r.out).not.toContain('Next step');
    });

    test('with no terminal it only prints the next step', () => {
        const release = makeRelease('7.0.1');
        const home = mkdtempSync(path.join(work, 'home-'));
        const r = install(release.script, home, release, { NUCLEON_NO_SETUP: '', NUCLEON_TTY: path.join(work, 'no-such-tty') });
        expect(r.code).toBe(0);
        expect(r.out).toContain('setup');
    });

    test('no colour codes when the output is not a terminal', () => {
        const release = makeRelease('7.0.2');
        const r = install(release.script, mkdtempSync(path.join(work, 'home-')), release);
        expect(r.out).not.toContain('\u001b[');
        expect(r.out).toContain('nucleon-sync');
    });

    test('running it twice changes nothing, and says the version was already there', () => {
        const home = newHome();
        install(v1.script, home, v1);
        const r = install(v1.script, home, v1);
        expect(r.code).toBe(0);
        expect(r.out).toContain('already there');
        expect(readlinkSync(path.join(app(home), 'current'))).toBe('versions/1.0.0');
        expect(readlinkSync(link(home))).toBe(path.join(app(home), 'current/bin/nucleon-sync'));
    });

    test('an existing version folder that is incomplete is reported, not trusted', () => {
        const home = newHome();
        mkdirSync(path.join(app(home), 'versions/1.0.0'), { recursive: true });
        const r = install(v1.script, home, v1, { NUCLEON_SWITCH: '0' });
        expect(r.code).toBe(1);
        expect(r.err).toContain('incomplete');
    });

    test('a release goes in a folder named after the full release, the archive keeps the number', () => {
        const home = newHome();
        const beta = makeRelease('4.0.0-beta');
        const r = install(beta.script, home, beta);
        expect(r.code).toBe(0);
        expect(readlinkSync(path.join(app(home), 'current'))).toBe('versions/4.0.0-beta');
        expect(existsSync(path.join(beta.dir, 'nucleon-sync-4.0.0.tar.gz'))).toBe(true);
        expect(r.out).toContain('nucleon-sync 4.0.0-beta is installed');
    });

    test('the archive is checked before bun is touched', () => {
        const home = newHome();
        install(v1.script, home, v1);
        const bun = path.join(app(home), 'bun/bun');
        writeFileSync(bun, '#!/bin/sh\necho 0.0.1\n', { mode: 0o755 });
        const r = install(v2.badScript, home, v2);
        expect(r.code).toBe(1);
        expect(r.err).toContain('checksum');
        expect(readFileSync(bun, 'utf8')).toContain('0.0.1');
    });

    test('unzip never waits for an answer', () => {
        const source = readFileSync(scriptSource, 'utf8');
        expect(source).toContain('unzip -oq "$TMP/bun.zip" -d "$TMP/bun-unzipped" </dev/null');
    });

    test('the next step uses the full path when the command is not in PATH', () => {
        const home = newHome();
        expect(install(v1.script, home, v1).out).toContain(`Next step: ${home}/.local/bin/nucleon-sync setup`);
        const inPath = newHome();
        expect(install(v1.script, inPath, v1, { PATH: `${inPath}/.local/bin:${process.env.PATH}` }).out).toContain('Next step: nucleon-sync setup');
    });

    test('a beta updates to the stable release of the same number, end to end', async () => {
        const beta = makeRelease('3.0.0-beta');
        const stable = makeRelease('3.0.0');
        const home = newHome();
        expect(install(beta.script, home, beta).code).toBe(0);
        const env = { PATH: process.env.PATH ?? '', HOME: home, NUCLEON_BASE_URL: `file://${stable.dir}`, NUCLEON_BUN_URL: `file://${stable.bunZip}`, NUCLEON_BUN_SHA256: sha(stable.bunZip), NUCLEON_UNAME_S: 'Linux', NUCLEON_UNAME_M: 'x86_64' };
        const message = await runUpdate({
            appDir: app(home),
            codeDir: path.join(app(home), 'versions/3.0.0-beta'),
            current: '3.0.0-beta',
            fetch: async (url) => ({ ok: true, json: async () => [{ tag_name: 'v3.0.0' }], text: async () => readFileSync(stable.script, 'utf8') }),
            run: (cmd, extra) => Bun.spawnSync(cmd, { env: { ...env, ...extra } }).exitCode,
            output: (cmd) => Bun.spawnSync(cmd, { env }).stdout.toString(),
            serviceInstalled: () => false,
            restart: () => true,
            serviceIsActive: () => true,
            wait: async () => {},
        });
        expect(message).toContain('updated to 3.0.0.');
        expect(readlinkSync(path.join(app(home), 'current'))).toBe('versions/3.0.0');
        expect(Bun.spawnSync([link(home)]).stdout.toString().trim()).toBe(releaseAppVersion('3.0.0'));
        expect(existsSync(path.join(app(home), 'versions/3.0.0-beta'))).toBe(true);
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
