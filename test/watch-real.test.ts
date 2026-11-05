import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The daemon relies on this exact call. Polling is the fallback, but a throw would stop it starting. */
async function seen(root: string, act: () => void, wanted: string) {
    const names: string[] = [];
    const w = watch(root, { recursive: true }, (_event, name) => name && names.push(String(name)));
    await Bun.sleep(100);
    act();
    for (let i = 0; i < 100 && !names.some((n) => n.endsWith(wanted)); i++) await Bun.sleep(20);
    w.close();
    return names.some((n) => n.endsWith(wanted));
}

test('recursive watch reports a change in an existing subfolder', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'proton-sync-watch-'));
    dirs.push(root);
    mkdirSync(path.join(root, 'Notes/sous'), { recursive: true });
    expect(await seen(root, () => writeFileSync(path.join(root, 'Notes/sous/n.md'), 'x'), 'n.md')).toBe(true);
});

test('recursive watch reports a change in a folder created after it started', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'proton-sync-watch-'));
    dirs.push(root);
    const act = async () => {
        mkdirSync(path.join(root, 'Nouveau'));
        await Bun.sleep(200);
        writeFileSync(path.join(root, 'Nouveau/n.md'), 'x');
    };
    expect(await seen(root, () => void act(), 'n.md')).toBe(true);
});
