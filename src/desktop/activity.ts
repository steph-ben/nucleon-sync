import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface Activity {
    at: string;
    label: string;
    path: string;
    error?: string;
}

const TAIL_BYTES = 256 * 1024;
const LINE = /^(\S+) (INFO |ERROR) (local→drive|drive→local|local) {2}(.+?) {2}(.+)$/;
const LABELS: Record<string, string> = {
    upload: 'Envoyé',
    'upload new version': 'Envoyé (nouvelle version)',
    download: 'Reçu',
    'download new version': 'Reçu (nouvelle version)',
    trash: 'Mis à la corbeille',
    quarantine: 'Mis en quarantaine',
    'conflict copy': 'Conflit : copie créée',
};

function tail(file: string): string {
    let fd: number;
    try {
        fd = openSync(file, 'r');
    } catch {
        return '';
    }
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        return buffer.toString('utf8');
    } finally {
        closeSync(fd);
    }
}

function describe(op: string, toDrive: boolean): string {
    if (op === 'move') return toDrive ? 'Déplacé sur le Drive' : 'Déplacé ici';
    if (op === 'mkdir') return toDrive ? 'Dossier créé sur le Drive' : 'Dossier créé ici';
    return LABELS[op] ?? op;
}

/** The journal already holds every real action: newest first, in plain words. Reads its end only. */
export function recentActivity(file: string, limit: number): Activity[] {
    const rows: Activity[] = [];
    for (const line of tail(file).split('\n').reverse()) {
        const m = LINE.exec(line);
        if (!m) continue;
        const [, at, level, direction, op, rest] = m as unknown as [string, string, string, string, string, string];
        const label = describe(op, direction === 'local→drive');
        if (level === 'ERROR') {
            const cut = rest.indexOf(': ');
            rows.push({ at, label: `Erreur : ${label}`, path: cut < 0 ? rest : rest.slice(0, cut), error: cut < 0 ? '' : rest.slice(cut + 2) });
        } else rows.push({ at, label, path: rest });
        if (rows.length === limit) break;
    }
    return rows;
}
