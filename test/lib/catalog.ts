import { afterEach, test } from 'bun:test';
import { appendFileSync } from 'node:fs';

import { cleanWorlds } from './world';

/** `proved`: tested for real. `limit`: a known limit, the test asserts it and its safe outcome. `trial`: only a real multi-day trial can confirm it. */
export type RowStatus = 'proved' | 'limit' | 'trial';

export interface Row {
    id: string;
    area: string;
    gesture: string;
    expected: string;
    status?: RowStatus;
    /** For a `limit` or `trial` row: what stays uncovered. */
    note?: string;
}

afterEach(cleanWorlds);

/** One catalogue line: a real test, whose outcome goes into the generated report. */
export function row(r: Row, fn: () => Promise<void> | void, timeout = 30000) {
    test(`${r.id}: ${r.gesture}`, async () => {
        let passed = false;
        try {
            await fn();
            passed = true;
        } finally {
            if (process.env.CATALOG_OUT) appendFileSync(process.env.CATALOG_OUT, `${JSON.stringify({ ...r, status: r.status ?? 'proved', passed })}\n`);
        }
    }, timeout);
}
