import { renameSync, writeFileSync } from 'node:fs';

export interface Problem {
    kind: 'session' | 'unreadable' | 'failing' | 'safety' | 'outdated';
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
    /** Deletions waiting for `nucleon-sync approve`. */
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

const NOTIFIED_KINDS: Problem['kind'][] = ['session', 'outdated', 'safety'];

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

function ago(ms: number): string {
    const min = Math.round(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function render(s: DesktopState, now: number): View {
    const lines: string[] = [];
    for (const p of s.problems) lines.push(p.message);
    if (s.held) lines.push(`${plural(s.held, 'deletion')} awaiting approval`);
    if (s.unseenDeletes.length) lines.push(`${plural(s.unseenDeletes.length, 'file')} moved to trash or quarantine`);
    if (s.transfer) lines.push(s.transfer.current);
    if (s.lastSyncAt) lines.push(`Last sync: ${ago(now - s.lastSyncAt)}`);
    if (s.problems.length || s.held) return { level: 'attention', title: 'Action needed', lines };
    if (s.unseenDeletes.length && !s.syncing && !s.paused) return { level: 'attention', title: 'Files deleted', lines };
    if (s.paused) return { level: 'paused', title: 'Paused', lines };
    if (s.syncing) return { level: 'syncing', title: s.transfer ? `Syncing ${s.transfer.done}/${s.transfer.total}` : 'Syncing', lines };
    return { level: 'ok', title: 'Up to date', lines };
}

/** Pure: what to tell the user when going from one state to the next. Nothing after a restart. */
export function notificationsFor(prev: DesktopState | undefined, next: DesktopState): Note[] {
    if (!prev) return [];
    const notes: Note[] = [];
    const known = new Set(prev.problems.map((p) => p.message));
    // Only problems that need the user: a network error after waking from sleep, or an unreadable file, stay in the icon and the menu.
    for (const p of next.problems) if (!known.has(p.message) && NOTIFIED_KINDS.includes(p.kind)) notes.push({ title: 'nucleon-sync: action needed', body: p.message });
    if (next.held > prev.held) notes.push({ title: `${plural(next.held, 'deletion')} to approve`, body: 'Review, then approve from the menu.' });
    if (next.conflicts > prev.conflicts) notes.push({ title: `Conflict: ${next.conflicts - prev.conflicts} ${next.conflicts - prev.conflicts > 1 ? 'copies' : 'copy'} created`, body: 'Both versions are kept.' });
    // Files moved to the trash or the quarantine are not announced one by one: an editor saving a file does this all day. They show in the menu and in `nucleon-sync activity`.
    return notes;
}

/** Atomic: an icon reading at the wrong moment never sees half a file. */
export function writeState(file: string, s: DesktopState, now: number) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...s, view: render(s, now) }));
    renameSync(tmp, file);
}
