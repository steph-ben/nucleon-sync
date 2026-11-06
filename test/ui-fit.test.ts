import { describe, expect, test } from 'bun:test';
import { fitLabel } from '../src/ui';

describe('spinner label', () => {
    const long = 'Comparing your Drive with the folder (the first time can take a few minutes)';
    test('a label that fits is left alone', () => {
        expect(fitLabel('Short', 80)).toBe('Short');
        expect(fitLabel(long, 120)).toBe(long);
    });
    test('a label wider than the terminal is cut so the row never wraps', () => {
        for (const columns of [40, 60, 70]) {
            const row = `  X ${fitLabel(long, columns)} 123s`;
            expect(row.length).toBeLessThan(columns);
        }
        expect(fitLabel(long, 40)).toEndWith('…');
    });
    test('an unknown or tiny width never throws or empties the label', () => {
        expect(fitLabel(long, undefined).length).toBeGreaterThan(0);
        expect(fitLabel(long, 5)).toBe(long);
    });
});
