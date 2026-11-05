import { Database } from 'bun:sqlite';
import type { Store } from '../core/interfaces';
import type { BaseRec } from '../core/types';
import { type ActivityRow, describeActivity } from '../desktop/activity';

const ACTIVITY_KEPT = 1000;

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
        const columns = this.db.query('PRAGMA table_info(base)').all() as { name: string }[];
        if (!columns.some((c) => c.name === 'localCtime')) this.db.exec('ALTER TABLE base ADD COLUMN localCtime INTEGER');
        this.db.exec('CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, label TEXT NOT NULL, path TEXT NOT NULL, error TEXT)');
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
            if (r.localCtime !== null) rec.localCtime = r.localCtime as number;
            return rec;
        });
    }

    put(rec: BaseRec): void {
        this.db
            .query('INSERT OR REPLACE INTO base (key,parent,name,kind,localId,remoteId,hash,size,localMtime,rev,localCtime) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(rec.key, rec.parent, rec.name, rec.kind, rec.localId, rec.remoteId, rec.hash ?? null, rec.size, rec.localMtime, rec.rev ?? null, rec.localCtime ?? null);
    }

    remove(key: string): void {
        this.db.query('DELETE FROM base WHERE key = ?').run(key);
    }

    /** One line per thing that really happened, in plain words, for the activity window. */
    addActivity(at: number, line: string, error?: string): void {
        const a = describeActivity(line, error);
        const r = this.db.query('INSERT INTO activity (at,label,path,error) VALUES (?,?,?,?)').run(at, a.label, a.path, a.error ?? null);
        this.db.query('DELETE FROM activity WHERE id <= ?').run(Number(r.lastInsertRowid) - ACTIVITY_KEPT);
    }

    recentActivity(limit: number): ActivityRow[] {
        return this.db.query('SELECT at,label,path,error FROM activity ORDER BY id DESC LIMIT ?').all(limit) as ActivityRow[];
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
