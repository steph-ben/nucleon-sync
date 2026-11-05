import { ROOT_MARKER, TMP_DIR } from './adapters/local';
import { SWAP_PREFIX } from './core/types';

/** The daemon's own writes raise file system events a few milliseconds later. */
const OWN_TTL_MS = 3000;

export type ChangeOrigin = 'ignored' | 'own' | 'local';

/**
 * Sorts file system events: noise (ignored files), echoes of what the daemon just wrote,
 * and real local changes. Only the last kind should wake the sync loop.
 */
export class ChangeTracker {
    private own_ = new Map<string, number>();
    private pending = new Set<string>();

    constructor(private ignore: (name: string, isDir: boolean) => boolean) {}

    /** Declares paths (relative to the root) that the daemon is about to write, plus their parents. */
    own(paths: string[], now: number): void {
        for (const [path, at] of this.own_) if (now - at > OWN_TTL_MS) this.own_.delete(path);
        for (const raw of paths) {
            const parts = raw.normalize('NFC').split('/');
            for (let i = 1; i <= parts.length; i++) this.own_.set(parts.slice(0, i).join('/'), now);
        }
    }

    classify(name: string, now: number): ChangeOrigin {
        const rel = name.normalize('NFC');
        const parts = rel.split('/');
        if (parts.some((c, i) => c === TMP_DIR || c === ROOT_MARKER || c.startsWith(SWAP_PREFIX) || this.ignore(c, i < parts.length - 1))) return 'ignored';
        const at = this.own_.get(rel);
        if (at !== undefined && now - at <= OWN_TTL_MS) return 'own';
        this.pending.add(rel);
        return 'local';
    }

    hasPending(): boolean {
        return this.pending.size > 0;
    }

    /** Local changes seen since the last call. */
    drain(): string[] {
        const names = [...this.pending];
        this.pending.clear();
        return names;
    }
}
