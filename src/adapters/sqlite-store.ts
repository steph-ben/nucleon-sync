import { Database } from 'bun:sqlite';
import type { Store } from '../core/interfaces';
import type { BaseRec } from '../core/types';

export class SqliteStore implements Store {
    private db: Database;

    constructor(file: string) {
        this.db = new Database(file, { create: true });
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = FULL');
        this.db.exec(`CREATE TABLE IF NOT EXISTS base (
            key TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
            localId TEXT NOT NULL, remoteId TEXT NOT NULL, hash TEXT, size INTEGER NOT NULL,
            localMtime INTEGER NOT NULL, rev TEXT)`);
        this.db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    }

    all(): BaseRec[] {
        const rows = this.db.query('SELECT * FROM base').all() as Record<string, unknown>[];
        return rows.map((r) => {
            const rec: BaseRec = {
                key: r.key as string,
                parent: r.parent as string,
                name: r.name as string,
                kind: r.kind as 'file' | 'dir',
                localId: r.localId as string,
                remoteId: r.remoteId as string,
                size: r.size as number,
                localMtime: r.localMtime as number,
            };
            if (r.hash !== null) rec.hash = r.hash as string;
            if (r.rev !== null) rec.rev = r.rev as string;
            return rec;
        });
    }

    put(rec: BaseRec): void {
        this.db
            .query('INSERT OR REPLACE INTO base (key,parent,name,kind,localId,remoteId,hash,size,localMtime,rev) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(rec.key, rec.parent, rec.name, rec.kind, rec.localId, rec.remoteId, rec.hash ?? null, rec.size, rec.localMtime, rec.rev ?? null);
    }

    remove(key: string): void {
        this.db.query('DELETE FROM base WHERE key = ?').run(key);
    }

    getKv(key: string): string | undefined {
        const r = this.db.query('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | null;
        return r?.v;
    }

    setKv(key: string, value: string): void {
        this.db.query('INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)').run(key, value);
    }

    close(): void {
        this.db.close();
    }
}
