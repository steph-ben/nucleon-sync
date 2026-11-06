import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { PathBusy, type LocalFs, type Source } from '../core/interfaces';
import { APP_NAME, LEGACY_ROOT_MARKER, LEGACY_TMP_DIR, ROOT_MARKER, TMP_DIR } from '../names';
import { type BaseRec, type Entry, ROOT, type Snapshot } from '../core/types';

export { ROOT_MARKER, TMP_DIR };

/** Creates the marker proving this folder really is the synced root. */
export async function createRootMarker(root: string): Promise<void> {
    await fsp.writeFile(path.join(root, ROOT_MARKER), `${APP_NAME}\n`, { flag: 'a' });
}

/** Files and folders that are never synced (caches, locks, system files). */
export function defaultIgnore(name: string, isDir: boolean): boolean {
    if (isDir && (name === '.venv' || name === '__pycache__')) return true;
    return (
        name === '.DS_Store' ||
        name.startsWith('._') ||
        name.startsWith('.nfs') ||
        name.startsWith('.rclone-') ||
        name.startsWith('~$') ||
        name.startsWith('.~lock.') ||
        name.endsWith('.swp') ||
        name.startsWith('.Trash')
    );
}

/** Hex SHA-1 of the content, read as a stream. */
export function sha1File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const h = createHash('sha1');
        const s = fs.createReadStream(file);
        s.on('data', (c) => h.update(c));
        s.on('error', reject);
        s.on('end', () => resolve(h.digest('hex')));
    });
}

/** Tests whether the file system under `root` is case-insensitive. */
export async function detectCaseInsensitive(root: string): Promise<boolean> {
    const dir = path.join(root, TMP_DIR);
    await fsp.mkdir(dir, { recursive: true });
    const name = `case-${randomBytes(6).toString('hex')}`;
    const file = path.join(dir, `${name}-a`);
    await fsp.writeFile(file, '');
    try {
        await fsp.lstat(path.join(dir, `${name}-A`));
        return true;
    } catch {
        return false;
    } finally {
        await fsp.unlink(file).catch(() => {});
    }
}

/**
 * Timestamps tick coarsely (a few ms on Linux): a file rewritten right after being hashed can keep
 * the same size, mtime and ctime. Until a file has been quiet this long its hash is never reused.
 */
const RACY_MS = 2000;

export interface LocalFsOptions {
    ignore?: (name: string, isDir: boolean) => boolean;
    /** ISO date/time; used to name the day's quarantine folder. */
    clock?: () => string;
    /** Current time in ms. */
    now?: () => number;
    /** Injectable to test the EXDEV case. */
    rename?: (from: string, to: string) => Promise<void>;
    /** Injectable to test an incomplete copy between volumes. */
    copy?: (from: string, to: string) => Promise<void>;
}

export class RealLocalFs implements LocalFs {
    scanWarnings: string[] = [];
    private ignore: (name: string, isDir: boolean) => boolean;
    private clock: () => string;
    private now: () => number;
    private rename: (from: string, to: string) => Promise<void>;
    private copy: (from: string, to: string) => Promise<void>;

    constructor(
        private root: string,
        private quarantineDir: string,
        opts: LocalFsOptions = {},
    ) {
        this.ignore = opts.ignore ?? defaultIgnore;
        this.clock = opts.clock ?? (() => new Date().toISOString());
        this.now = opts.now ?? Date.now;
        this.rename = opts.rename ?? fsp.rename;
        this.copy = opts.copy ?? ((from, to) => fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }));
    }

    /** The ctime to remember, or 0 while the file is too recent for its timestamps to prove anything. */
    private settledCtime(ctimeMs: number): number {
        const ctime = Math.floor(ctimeMs);
        return this.now() - ctime < RACY_MS ? 0 : ctime;
    }

    /** Safe absolute path: rejects `..` and absolute paths. */
    absolutePath(rel: string): string {
        if (rel === '' || path.isAbsolute(rel) || rel.includes('\0')) throw new Error(`invalid relative path: "${rel}"`);
        if (rel.split(/[\\/]/).some((p) => p === '..' || p === '')) throw new Error(`forbidden path (empty component or ..): "${rel}"`);
        return path.join(this.root, rel);
    }

    async assertRootSafe(): Promise<void> {
        let st;
        try {
            st = await fsp.stat(this.root);
        } catch {
            throw new Error(`local root missing: ${this.root}`);
        }
        if (!st.isDirectory()) throw new Error(`local root is not a folder: ${this.root}`);
        const hasMarker = async (name: string) => !!(await fsp.lstat(path.join(this.root, name)).catch(() => null));
        if (!(await hasMarker(ROOT_MARKER)) && !(await hasMarker(LEGACY_ROOT_MARKER))) {
            throw new Error(`marker ${ROOT_MARKER} missing from ${this.root}: root not trusted`);
        }
    }

    async scan(known: Map<string, BaseRec>): Promise<Snapshot> {
        this.scanWarnings = [];
        const snap: Snapshot = new Map();
        await this.walk('', ROOT, snap, known);
        return snap;
    }

    private async walk(rel: string, parentId: string, snap: Snapshot, known: Map<string, BaseRec>): Promise<void> {
        const abs = rel === '' ? this.root : path.join(this.root, rel);
        let names: string[];
        try {
            names = (await fsp.readdir(abs)).sort();
        } catch (e) {
            this.scanWarnings.push(`cannot read folder: ${rel || '.'} (${(e as Error).message})`);
            return;
        }
        for (const name of names) {
            const childRel = rel === '' ? name : `${rel}/${name}`;
            if (rel === '' && (name === ROOT_MARKER || name === LEGACY_ROOT_MARKER || name === TMP_DIR || name === LEGACY_TMP_DIR)) continue;
            let st: fs.Stats;
            try {
                st = await fsp.lstat(path.join(abs, name));
            } catch (e) {
                this.scanWarnings.push(`vanished during scan: ${childRel} (${(e as Error).message})`);
                continue;
            }
            const isDir = st.isDirectory();
            if (!isDir && !st.isFile()) continue; // symlink or special file: never followed
            if (this.ignore(name, isDir)) continue;
            let id = `${st.dev}:${st.ino}`;
            if (snap.has(id)) id = `${id}#${childRel}`;
            const mtime = Math.floor(st.mtimeMs);
            const ctime = this.settledCtime(st.ctimeMs);
            if (isDir) {
                snap.set(id, { id, parent: parentId, name, kind: 'dir', size: 0, mtime });
                await this.walk(childRel, id, snap, known);
                continue;
            }
            const k = known.get(id);
            let hash: string | undefined;
            if (k?.hash && k.size === st.size && k.localMtime === mtime && (k.localCtime === undefined || (ctime !== 0 && k.localCtime === ctime))) hash = k.hash;
            else {
                try {
                    hash = await sha1File(path.join(abs, name));
                } catch (e) {
                    this.scanWarnings.push(`cannot read: ${childRel} (${(e as Error).message})`);
                    continue;
                }
            }
            snap.set(id, { id, parent: parentId, name, kind: 'file', size: st.size, mtime, ctime, hash });
        }
    }

    async mkdir(rel: string): Promise<Entry> {
        const abs = this.absolutePath(rel);
        try {
            await fsp.mkdir(abs);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new PathBusy(`name already taken: ${rel}`);
            throw e;
        }
        const st = await fsp.lstat(abs);
        return { id: `${st.dev}:${st.ino}`, parent: ROOT, name: path.basename(rel), kind: 'dir', size: 0, mtime: Math.floor(st.mtimeMs) };
    }

    async move(from: string, to: string): Promise<void> {
        const a = this.absolutePath(from);
        const b = this.absolutePath(to);
        const src = await fsp.lstat(a);
        let dst: fs.Stats | undefined;
        try {
            dst = await fsp.lstat(b);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (dst && !(dst.dev === src.dev && dst.ino === src.ino && a !== b)) throw new PathBusy(`destination busy: ${to}`);
        // Residual race: Node has no atomic rename-without-replace on macOS.
        // A file created between the lstat above and the rename would be overwritten; the window
        // is a few microseconds and the engine rechecks the state on every pass.
        await this.rename(a, b);
    }

    async isUnchanged(rel: string, entry: Entry): Promise<boolean> {
        try {
            const st = await fsp.lstat(this.absolutePath(rel));
            if (`${st.dev}:${st.ino}` !== entry.id && !entry.id.startsWith(`${st.dev}:${st.ino}#`)) return false;
            if (entry.kind === 'dir') return st.isDirectory();
            return st.isFile() && st.size === entry.size && Math.floor(st.mtimeMs) === entry.mtime && (!entry.ctime || Math.floor(st.ctimeMs) === entry.ctime);
        } catch {
            return false;
        }
    }

    async quarantine(rel: string): Promise<void> {
        const src = this.absolutePath(rel);
        await fsp.lstat(src);
        const day = this.clock().slice(0, 10);
        const dayDir = path.join(this.quarantineDir, day);
        await fsp.mkdir(dayDir, { recursive: true });
        const slot = await fsp.mkdtemp(path.join(dayDir, 'q-'));
        const dest = path.join(slot, rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        try {
            await this.rename(src, dest);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
            // Other volume: copy, verify, and only then remove the original.
            await this.copy(src, dest);
            const [a, b] = await Promise.all([treeSize(src), treeSize(dest)]);
            if (a.size !== b.size || a.count !== b.count) throw new Error(`incomplete quarantine copy for ${rel}: original kept`);
            await fsp.rm(src, { recursive: true });
        }
    }

    async openSource(rel: string): Promise<Source> {
        const st = await fsp.lstat(this.absolutePath(rel));
        if (!st.isFile()) throw new Error(`not a regular file: ${rel}`);
        return { size: st.size, mtime: Math.floor(st.mtimeMs) };
    }

    async writeFile(rel: string, expectedHash: string | undefined, mtime: number, fill: (tmpPath: string) => Promise<void>, beforeInstall?: () => Promise<void>): Promise<Entry> {
        const dest = this.absolutePath(rel);
        const tmpDir = path.join(this.root, TMP_DIR);
        await fsp.mkdir(tmpDir, { recursive: true });
        const tmp = path.join(tmpDir, randomBytes(12).toString('hex'));
        try {
            await fill(tmp);
            const hash = await sha1File(tmp);
            if (expectedHash !== undefined && hash !== expectedHash) {
                throw new Error(`SHA-1 mismatch for ${rel}: expected ${expectedHash}, got ${hash}`);
            }
            const fd = await fsp.open(tmp, 'r+');
            try {
                await fd.sync();
            } finally {
                await fd.close();
            }
            await fsp.utimes(tmp, mtime / 1000, mtime / 1000);
            await beforeInstall?.();
            try {
                // link() fails with EEXIST if the destination exists: no overwrite possible.
                await fsp.link(tmp, dest);
            } catch (e) {
                const code = (e as NodeJS.ErrnoException).code;
                if (code === 'EEXIST') throw new PathBusy(`destination already taken: ${rel}`);
                if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw e;
                // No hard links: fall back to lstat then rename (small race window).
                try {
                    await fsp.lstat(dest);
                    throw new PathBusy(`destination already taken: ${rel}`);
                } catch (e2) {
                    if (e2 instanceof PathBusy) throw e2;
                }
                await fsp.rename(tmp, dest);
            }
            // Removing the temporary hard link changes the inode's ctime: read it afterwards.
            await fsp.unlink(tmp).catch(() => {});
            const st = await fsp.lstat(dest);
            return { id: `${st.dev}:${st.ino}`, parent: ROOT, name: path.basename(rel), kind: 'file', size: st.size, mtime: Math.floor(st.mtimeMs), ctime: this.settledCtime(st.ctimeMs), hash };
        } finally {
            await fsp.unlink(tmp).catch(() => {});
        }
    }
}

async function treeSize(p: string): Promise<{ size: number; count: number }> {
    const st = await fsp.lstat(p);
    if (!st.isDirectory()) return { size: st.size, count: 1 };
    let size = 0;
    let count = 1;
    for (const n of await fsp.readdir(p)) {
        const r = await treeSize(path.join(p, n));
        size += r.size;
        count += r.count;
    }
    return { size, count };
}

