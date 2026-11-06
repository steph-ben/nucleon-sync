import type { CycleResult } from '../core/engine';
import { anyOutdatedClient, isOutdatedClient } from './signin';
import { type DesktopState, type Note, notificationsFor, type Problem, writeState } from './state';

const FAILURES_BEFORE_ALERT = 3;
const MAX_UNSEEN = 1000;
export const UNSEEN_KEY = 'unseen-deletes';

interface Kv {
    getKv(key: string): string | undefined;
    setKv(key: string, value: string): void;
}

const OUTDATED: Problem = { kind: 'outdated', message: 'This version is no longer accepted by Proton: run nucleon-sync update' };
const isSession = (m: string) => /\b401\b|session|not logged in|unauthorized|invalid.*token/i.test(m);

/** Turns what the daemon does into what the user sees. */
export class DesktopTracker {
    state: DesktopState;
    private previous: DesktopState | undefined;
    private failures = 0;
    private passProblems: Problem[] = [];

    constructor(
        private file: string,
        pid: number,
        private kv: Kv,
        private notify: (n: Note) => void,
        private now: () => number,
        private paused: () => boolean,
    ) {
        this.state = { pid, heartbeatAt: now(), paused: paused(), syncing: false, problems: [], held: 0, unseenDeletes: [], conflicts: 0 };
    }

    private unseen(): string[] {
        return JSON.parse(this.kv.getKv(UNSEEN_KEY) ?? '[]') as string[];
    }

    /** Publishes the state and tells the user what changed. Also serves as the heartbeat. */
    flush() {
        this.state = { ...this.state, heartbeatAt: this.now(), paused: this.paused(), unseenDeletes: this.unseen() };
        writeState(this.file, this.state, this.now());
        for (const n of notificationsFor(this.previous, this.state)) this.notify(n);
        this.previous = this.state;
    }

    passStart() {
        this.state = { ...this.state, syncing: true, transfer: undefined };
        this.flush();
    }

    progress(done: number, total: number, line: string) {
        this.state = { ...this.state, transfer: { done, total, current: line.replace(/\s+/g, ' ').trim() } };
        this.flush();
    }

    passDone(r: CycleResult) {
        if (r.deleted.length) this.kv.setKv(UNSEEN_KEY, JSON.stringify([...this.unseen(), ...r.deleted].slice(-MAX_UNSEEN)));
        const unreadable = r.plan.warnings.filter((w) => w.startsWith('cannot read')).map((message): Problem => ({ kind: 'unreadable', message }));
        this.failures = r.errors.length ? this.failures + 1 : 0;
        const outdated = anyOutdatedClient(r.errors);
        const failing: Problem[] = outdated ? [OUTDATED] : this.failures >= FAILURES_BEFORE_ALERT ? [{ kind: 'failing', message: `Repeated errors: ${r.errors[0]}` }] : [];
        this.state = { ...this.state, syncing: false, transfer: undefined, lastSyncAt: r.errors.length ? this.state.lastSyncAt : this.now(), held: r.plan.held.length, conflicts: this.state.conflicts + r.conflicts, problems: [...unreadable, ...failing] };
        this.flush();
    }

    passFailed(e: unknown, safety: boolean) {
        const message = e instanceof Error ? e.message : String(e);
        this.failures++;
        let problems: Problem[] = [];
        if (safety) problems = [{ kind: 'safety', message: `Safety stop: ${message}` }];
        else if (isOutdatedClient(message)) problems = [OUTDATED];
        else if (isSession(message)) problems = [{ kind: 'session', message: 'Proton session expired: run nucleon-sync login' }];
        else if (this.failures >= FAILURES_BEFORE_ALERT) problems = [{ kind: 'failing', message: `Sync failed: ${message}` }];
        this.state = { ...this.state, syncing: false, transfer: undefined, problems };
        this.flush();
    }
}
