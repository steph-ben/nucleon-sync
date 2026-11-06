import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = path.resolve(import.meta.dir, '../desktop/linux/nucleon-sync-tray.py');
const hasPython = Bun.which('python3') !== null;

// A fake `gi` that knows only the namespaces listed in STUB_NAMESPACES (like a machine with some typelibs missing).
const stubDir = mkdtempSync(path.join(tmpdir(), 'tray-stub-'));
mkdirSync(path.join(stubDir, 'gi'));
writeFileSync(
    path.join(stubDir, 'gi', '__init__.py'),
    `import os

def require_version(name, version):
    if name not in os.environ["STUB_NAMESPACES"].split(","):
        raise ValueError("Namespace %s not available" % name)
`,
);
writeFileSync(
    path.join(stubDir, 'gi', 'repository.py'),
    `from types import SimpleNamespace

AyatanaAppIndicator3 = SimpleNamespace(NAME="AyatanaAppIndicator3")
AppIndicator3 = SimpleNamespace(NAME="AppIndicator3")
`,
);

// Loads the tray script as a module (no GTK needed) and calls only the namespace selection.
const driver = `
import importlib.util, sys
sys.path.insert(0, ${JSON.stringify(stubDir)})
spec = importlib.util.spec_from_file_location("tray", ${JSON.stringify(script)})
tray = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tray)
print(tray.load_indicator().NAME)
`;

function chooseWith(namespaces: string) {
    const run = Bun.spawnSync(['python3', '-I', '-c', driver], { env: { ...process.env, STUB_NAMESPACES: namespaces } });
    return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString() };
}

afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

describe.skipIf(!hasPython)('linux tray indicator namespace', () => {
    test('uses AyatanaAppIndicator3 when it is available', () => {
        expect(chooseWith('AyatanaAppIndicator3,AppIndicator3').out).toBe('AyatanaAppIndicator3');
    });

    test('falls back to AppIndicator3 when only the old one is installed', () => {
        const result = chooseWith('AppIndicator3');
        expect(result.code).toBe(0);
        expect(result.out).toBe('AppIndicator3');
    });

    test('neither: one clear message naming both packages, exit 1, no traceback', () => {
        const result = chooseWith('');
        expect(result.code).toBe(1);
        expect(result.err).toContain('libayatana-appindicator-gtk3');
        expect(result.err).toContain('libappindicator-gtk3');
        expect(result.err).not.toContain('Traceback');
    });
});

test('every state has its own icon, and the logo itself', () => {
    const { existsSync, readFileSync } = require('node:fs');
    const path = require('node:path');
    const dir = path.join(import.meta.dir, '../desktop/linux/icons');
    for (const name of ['ok', 'syncing', 'paused', 'attention', 'stopped']) {
        const file = path.join(dir, `nucleon-sync-${name}.svg`);
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, 'utf8')).toContain('<svg');
    }
    expect(existsSync(path.join(dir, 'nucleon-sync.svg'))).toBe(true);
});

// Calls the version helpers with a fake install: <root>/VERSION and <root>/desktop/linux/nucleon-sync-tray.py.
function versionDriver(root: string) {
    return `
import importlib.util, os, sys
sys.path.insert(0, ${JSON.stringify(stubDir)})
spec = importlib.util.spec_from_file_location("tray", ${JSON.stringify(script)})
tray = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tray)
fake = os.path.join(${JSON.stringify(root)}, "desktop", "linux", "nucleon-sync-tray.py")
print(repr(tray.read_version(fake)))
print(tray.version_changed("0.2.2-beta", "0.2.3-beta"), tray.version_changed("0.2.2-beta", "0.2.2-beta"), tray.version_changed("0.2.2-beta", None), tray.version_changed(None, "0.2.3-beta"))
`;
}

describe('the tray follows updates', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tray-version-'));
    mkdirSync(path.join(root, 'desktop', 'linux'), { recursive: true });
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const ask = () => Bun.spawnSync(['python3', '-I', '-c', versionDriver(root)]).stdout.toString().trim().split('\n');

    test.skipIf(!hasPython)('it reads the release from the VERSION file of its install', () => {
        writeFileSync(path.join(root, 'VERSION'), '0.2.3-beta\n');
        expect(ask()[0]).toBe("'0.2.3-beta'");
    });
    test.skipIf(!hasPython)('a missing file means no answer, and no answer never restarts the tray', () => {
        rmSync(path.join(root, 'VERSION'));
        const lines = ask();
        expect(lines[0]).toBe('None');
        expect(lines[1]).toBe('True False False False');
    });
});
