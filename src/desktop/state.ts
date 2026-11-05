import { renameSync, writeFileSync } from 'node:fs';

export interface Problem {
    kind: 'session' | 'unreadable' | 'failing' | 'safety';
    message: string;
}

/** What the daemon knows. Everything shown to the user is derived from it. */
export interface DesktopState {
    pid: number;
    heartbeatAt: number;
    paused: boolean;
    syncing: boolean;
    transfer?: { done: number; total: number; current: string };
    lastSyncAt?: number;
    problems: Problem[];
    /** Deletions waiting for `proton-sync approve`. */
    held: number;
    /** Items sent to the trash or quarantine since the user last acknowledged them. */
    unseenDeletes: string[];
    /** Conflict copies created so far. */
    conflicts: number;
}

export interface View {
    level: 'ok' | 'syncing' | 'paused' | 'attention';
    title: string;
    lines: string[];
}

export interface Note {
    title: string;
    body: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

function ago(ms: number): string {
    const min = Math.round(ms / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return `il y a ${min} min`;
    const h = Math.round(min / 60);
    return h < 24 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
}

export function render(s: DesktopState, now: number): View {
    const lines: string[] = [];
    for (const p of s.problems) lines.push(p.message);
    if (s.held) lines.push(`${plural(s.held, 'suppression')} en attente de validation`);
    if (s.unseenDeletes.length) lines.push(`${plural(s.unseenDeletes.length, 'fichier')} parti${s.unseenDeletes.length > 1 ? 's' : ''} en corbeille ou quarantaine`);
    if (s.transfer) lines.push(s.transfer.current);
    if (s.lastSyncAt) lines.push(`Dernière synchro : ${ago(now - s.lastSyncAt)}`);
    if (s.problems.length || s.held) return { level: 'attention', title: 'Action requise', lines };
    if (s.unseenDeletes.length && !s.syncing && !s.paused) return { level: 'attention', title: 'Fichiers supprimés', lines };
    if (s.paused) return { level: 'paused', title: 'En pause', lines };
    if (s.syncing) return { level: 'syncing', title: s.transfer ? `Synchronisation ${s.transfer.done}/${s.transfer.total}` : 'Synchronisation', lines };
    return { level: 'ok', title: 'À jour', lines };
}

/** Pure: what to tell the user when going from one state to the next. Nothing after a restart. */
export function notificationsFor(prev: DesktopState | undefined, next: DesktopState): Note[] {
    if (!prev) return [];
    const notes: Note[] = [];
    const known = new Set(prev.problems.map((p) => p.message));
    for (const p of next.problems) if (!known.has(p.message)) notes.push({ title: 'proton-sync : action requise', body: p.message });
    if (prev.problems.length && !next.problems.length) notes.push({ title: 'proton-sync : synchro rétablie', body: 'Tout fonctionne à nouveau.' });
    if (next.held > prev.held) notes.push({ title: `${plural(next.held, 'suppression')} à valider`, body: 'Vérifie puis valide depuis le menu.' });
    if (next.conflicts > prev.conflicts) notes.push({ title: `Conflit : ${plural(next.conflicts - prev.conflicts, 'copie')} créée${next.conflicts - prev.conflicts > 1 ? 's' : ''}`, body: 'Les deux versions sont conservées.' });
    const fresh = next.unseenDeletes.filter((d) => !prev.unseenDeletes.includes(d));
    if (fresh.length) notes.push({ title: `${plural(fresh.length, 'fichier')} en corbeille ou quarantaine`, body: fresh.slice(0, 3).join(', ') });
    return notes;
}

/** Atomic: an icon reading at the wrong moment never sees half a file. */
export function writeState(file: string, s: DesktopState, now: number) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...s, view: render(s, now) }));
    renameSync(tmp, file);
}
