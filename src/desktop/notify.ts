import type { Note } from './state';

/** Text only travels as arguments: a file name can never become code. */
export function noteCommand(platform: string, n: Note): string[] {
    if (platform === 'darwin') return ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', n.title, n.body];
    return ['notify-send', '--app-name=nucleon-sync', '--', n.title, n.body];
}

/** Best effort: a missing notifier must never disturb the sync. */
export function sendNote(n: Note) {
    try {
        Bun.spawn(noteCommand(process.platform, n), { stdout: 'ignore', stderr: 'ignore' });
    } catch {
        /* nothing to do */
    }
}
