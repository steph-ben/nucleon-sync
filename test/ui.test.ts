import { expect, test } from 'bun:test';
import { banner, bold, mark, waiting, working } from '../src/ui';

// The tests run with no terminal: everything must come out as plain text.
test('no colour codes without a terminal', () => {
    expect(bold('x')).toBe('x');
    expect(banner().join('\n')).not.toContain('\u001b[');
    expect(banner().join('\n')).toContain('nucleon-sync');
    expect(mark.ok()).toBe('+');
});

test('working runs the task and returns its result, with no animation in a pipe', async () => {
    expect(await working('slow thing', async () => 42)).toBe(42);
    await expect(working('failing thing', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
});

test('waiting returns a function that can be called once done', () => {
    const stop = waiting('waiting for you');
    expect(() => stop()).not.toThrow();
});
