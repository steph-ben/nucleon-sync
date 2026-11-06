import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { askYesNo } from '../src/desktop/setup';

// The real prompt() of Bun, in a real process: a unit test with a fake answer once passed while Enter did nothing.
const setup = path.resolve(import.meta.dir, '../src/desktop/setup.ts');
function answer(input: string, defaultYes: boolean): string {
    const code = `import { askYesNo } from ${JSON.stringify(setup)}; console.log('RESULT=' + await askYesNo('Start?', ${defaultYes}));`;
    const run = Bun.spawnSync([process.execPath, '-e', code], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' });
    return /RESULT=(\w+)/.exec(run.stdout.toString())?.[1] ?? `no result: ${run.stderr.toString()}`;
}

describe('the yes/no question of setup, with the real prompt', () => {
    test('Enter takes the default answer', () => {
        expect(answer('\n', true)).toBe('true');
        expect(answer('\n', false)).toBe('false');
    });
    test('y and n are taken as typed', () => {
        expect(answer('y\n', false)).toBe('true');
        expect(answer('n\n', true)).toBe('false');
    });
    test('a closed input is always no, also when the default is yes', () => {
        expect(answer('', true)).toBe('false');
    });
    test('the question is shown once, without the brackets Bun adds around a default', () => {
        const code = `import { askYesNo } from ${JSON.stringify(setup)}; await askYesNo('Start? [Y/n]', true);`;
        const run = Bun.spawnSync([process.execPath, '-e', code], { stdin: Buffer.from('\n'), stdout: 'pipe', stderr: 'pipe' });
        expect(run.stdout.toString()).toContain('Start? [Y/n] ');
        expect(run.stdout.toString()).not.toContain('[]');
    });
    test('a fake answer follows the same rules', async () => {
        expect(await askYesNo('?', true, async () => '')).toBe(true);
        expect(await askYesNo('?', true, async () => null)).toBe(false);
    });
});
