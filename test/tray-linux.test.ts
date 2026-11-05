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
