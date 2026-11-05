import type { Machine } from './world';

export class Crash extends Error {}

/** Calls `hook` around every effect a machine has on the world. */
export function instrument(m: Machine, hook: (op: string) => void) {
    const wrap = (target: object, methods: string[]) => {
        const t = target as Record<string, (...a: unknown[]) => Promise<unknown>>;
        for (const name of methods) {
            const real = t[name]!.bind(target);
            t[name] = async (...args: unknown[]) => {
                hook(`${name} before`);
                const result = await real(...args);
                hook(`${name} after`);
                return result;
            };
        }
    };
    wrap(m.local, ['mkdir', 'move', 'quarantine', 'writeFile']);
    wrap(m.drive, ['mkdir', 'move', 'upload', 'uploadRevision', 'download', 'trash']);
}
