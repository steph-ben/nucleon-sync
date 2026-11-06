import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The Linux tray (python) and the macOS tray (swift) are two programs for one menu. They must say and show the same things.
// When this test fails, change both files, not the test.
const desktop = path.resolve(import.meta.dir, '../desktop');
const py = readFileSync(path.join(desktop, 'linux/nucleon-sync-tray.py'), 'utf8');
const swift = readFileSync(path.join(desktop, 'macos/NucleonSyncTray.swift'), 'utf8');

/** "key": "value" pairs between a start marker and the closing bracket at the start of a line. */
function pairs(source: string, start: RegExp): Record<string, string> {
    const from = source.search(start);
    expect(from).toBeGreaterThanOrEqual(0);
    const end = source.slice(from).search(/^[\]}]/m);
    const block = source.slice(from, from + end);
    return Object.fromEntries([...block.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
}

describe('the two tray programs show the same menu', () => {
    test('the words of the activity labels are the same', () => {
        const a = pairs(py, /^LABELS = \{/m);
        const b = pairs(swift, /^let labels = \[/m);
        expect(Object.keys(a).length).toBeGreaterThan(5);
        expect(b).toEqual(a);
    });

    test('the menu rows are in the same order, with the same words', () => {
        const rows = ['nucleon-sync ', 'Resume', 'Pause', 'Approve', 'Mark deletions as seen', 'Recent activity…', 'Open folder', 'Open technical log', 'Quit icon'];
        for (const [name, source] of [['python', py], ['swift', swift]] as const) {
            const at = rows.map((row) => source.indexOf(row === 'Approve' ? row : `"${row}`));
            expect({ name, missing: rows.filter((_, i) => at[i] === -1) }).toEqual({ name, missing: [] });
            expect({ name, ordered: at.every((x, i) => i === 0 || x > at[i - 1]!) }).toEqual({ name, ordered: true });
        }
        expect(py).toContain('f"Approve {state[\'held\']} deletions"');
        expect(swift).toContain('"Approve \\(state.held) deletions"');
    });

    test('the same texts appear in both: windows, columns, notification, stopped state', () => {
        for (const text of ['nucleon-sync: recent activity', 'When', 'Action', 'File', 'nucleon-sync: sync stopped', 'The daemon stopped responding.', 'Sync stopped', 'The daemon is not running.', 'Moved on Drive', 'Moved here', 'Folder created on Drive', 'Folder created here', 'Error: ']) {
            expect({ text, py: py.includes(`"${text}`), swift: swift.includes(`"${text}`) }).toEqual({ text, py: true, swift: true });
        }
        expect(py).toContain('"%d/%m %H:%M:%S"');
        expect(swift).toContain('"dd/MM HH:mm:ss"');
    });

    test('the header shows the release, the menu follows the same five states, and the same limits apply', () => {
        expect(py).toContain('"nucleon-sync " + started');
        expect(swift).toContain('"nucleon-sync " + $0');
        for (const level of ['ok', 'syncing', 'paused', 'attention', 'stopped']) {
            expect(py).toContain(`"${level}": "`);
            expect(swift).toContain(`"${level}": "`);
        }
        expect(py).toContain('DAEMON_GONE_SECONDS = 180');
        expect(swift).toContain('let daemonGoneSeconds = 180.0');
        expect(py).toContain('TAIL_BYTES = 256 * 1024');
        expect(swift).toContain('let tailBytes = 256 * 1024');
        expect(py).toContain('timeout_add_seconds(3, refresh)');
        expect(swift).toContain('withTimeInterval: 3');
    });

    test('both restart by themselves when an update installs another release', () => {
        expect(py).toContain('version_changed(started, read_version())');
        expect(swift).toContain('restartIfUpdated()');
        expect(swift).toContain('/VERSION');
    });

    test('the same five states have an icon on both, and the logo of the menu has a transparent PNG for macOS', () => {
        for (const level of ['ok', 'syncing', 'paused', 'attention']) {
            expect(readdirSync(path.join(desktop, 'linux/icons'))).toContain(`nucleon-sync-${level}.svg`);
            expect(swift).toContain(`case "${level}":`);
        }
        expect(readdirSync(path.join(desktop, 'linux/icons'))).toContain('nucleon-sync-stopped.svg');
        expect(swift).toContain('default: // stopped');
        expect(swift).toContain('image.isTemplate = true');
        // macOS cannot read the SVG logo before macOS 13: run scripts/render-mac-icons.sh after changing it.
        expect(readdirSync(path.join(desktop, 'macos/icons'))).toEqual(['nucleon-sync.png']);
    });
});
