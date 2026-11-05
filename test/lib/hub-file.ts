import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import { Hub } from '../sim';

/** The fake Drive survives a killed process by living in a file. */
export function saveHub(hub: Hub, file: string) {
    const raw = hub as unknown as { seq: number };
    writeFileSync(`${file}.tmp`, JSON.stringify({ seq: raw.seq, nodes: [...hub.nodes.values()] }));
    renameSync(`${file}.tmp`, file);
}

export function loadHub(file: string): Hub {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const hub = new Hub();
    (hub as unknown as { seq: number }).seq = data.seq;
    for (const n of data.nodes) hub.nodes.set(n.id, n);
    return hub;
}
