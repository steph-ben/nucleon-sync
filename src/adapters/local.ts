import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { PathBusy, type LocalFs, type Source } from '../core/interfaces';
import { type BaseRec, type Entry, ROOT, type Snapshot } from '../core/types';

export const ROOT_MARKER = '.proton-sync-root';
export const TMP_DIR = '.proton-sync-tmp';

/** Crée le marqueur qui prouve que ce dossier est bien la racine synchronisée. */
export async function createRootMarker(root: string): Promise<void> {
    await fsp.writeFile(path.join(root, ROOT_MARKER), 'proton-sync\n', { flag: 'a' });
}

/** Fichiers et dossiers jamais synchronisés (caches, verrous, fichiers système). */
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

/** SHA-1 hexadécimal du contenu, lu en flux. */
export function sha1File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const h = createHash('sha1');
        const s = fs.createReadStream(file);
        s.on('data', (c) => h.update(c));
        s.on('error', reject);
        s.on('end', () => resolve(h.digest('hex')));
    });
}

/** Teste si le système de fichiers sous `root` ignore la casse. */
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

export interface LocalFsOptions {
    ignore?: (name: string, isDir: boolean) => boolean;
    /** Date/heure ISO ; sert à nommer le dossier du jour en quarantaine. */
    clock?: () => string;
    /** Injectable pour tester le cas EXDEV. */
    rename?: (from: string, to: string) => Promise<void>;
}

export class RealLocalFs implements LocalFs {
    scanWarnings: string[] = [];
    private ignore: (name: string, isDir: boolean) => boolean;
    private clock: () => string;
    private rename: (from: string, to: string) => Promise<void>;

    constructor(
        private root: string,
        private quarantineDir: string,
        opts: LocalFsOptions = {},
    ) {
        this.ignore = opts.ignore ?? defaultIgnore;
        this.clock = opts.clock ?? (() => new Date().toISOString());
        this.rename = opts.rename ?? fsp.rename;
    }

    /** Chemin absolu sûr : refuse `..` et les chemins absolus. */
    absolutePath(rel: string): string {
        if (rel === '' || path.isAbsolute(rel) || rel.includes('\0')) throw new Error(`chemin relatif invalide : "${rel}"`);
        if (rel.split(/[\\/]/).some((p) => p === '..' || p === '')) throw new Error(`chemin interdit (composant vide ou ..) : "${rel}"`);
        return path.join(this.root, rel);
    }

    async assertRootSafe(): Promise<void> {
        let st;
        try {
            st = await fsp.stat(this.root);
        } catch {
            throw new Error(`racine locale absente : ${this.root}`);
        }
        if (!st.isDirectory()) throw new Error(`la racine locale n'est pas un dossier : ${this.root}`);
        try {
            await fsp.lstat(path.join(this.root, ROOT_MARKER));
        } catch {
            throw new Error(`marqueur ${ROOT_MARKER} absent de ${this.root} : racine non fiable`);
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
            this.scanWarnings.push(`lecture du dossier impossible : ${rel || '.'} (${(e as Error).message})`);
            return;
        }
        for (const name of names) {
            const childRel = rel === '' ? name : `${rel}/${name}`;
            if (rel === '' && (name === ROOT_MARKER || name === TMP_DIR)) continue;
            let st: fs.Stats;
            try {
                st = await fsp.lstat(path.join(abs, name));
            } catch (e) {
                this.scanWarnings.push(`disparu pendant le scan : ${childRel} (${(e as Error).message})`);
                continue;
            }
            const isDir = st.isDirectory();
            if (!isDir && !st.isFile()) continue; // lien symbolique ou fichier spécial : jamais suivi
            if (this.ignore(name, isDir)) continue;
            let id = `${st.dev}:${st.ino}`;
            if (snap.has(id)) id = `${id}#${childRel}`;
            const mtime = Math.floor(st.mtimeMs);
            if (isDir) {
                snap.set(id, { id, parent: parentId, name, kind: 'dir', size: 0, mtime });
                await this.walk(childRel, id, snap, known);
                continue;
            }
            const k = known.get(id);
            let hash: string | undefined;
            if (k?.hash && k.size === st.size && k.localMtime === mtime) hash = k.hash;
            else {
                try {
                    hash = await sha1File(path.join(abs, name));
                } catch (e) {
                    this.scanWarnings.push(`lecture impossible : ${childRel} (${(e as Error).message})`);
                    continue;
                }
            }
            snap.set(id, { id, parent: parentId, name, kind: 'file', size: st.size, mtime, hash });
        }
    }

    async mkdir(rel: string): Promise<Entry> {
        const abs = this.absolutePath(rel);
        try {
            await fsp.mkdir(abs);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new PathBusy(`nom déjà occupé : ${rel}`);
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
        if (dst && !(dst.dev === src.dev && dst.ino === src.ino && a !== b)) throw new PathBusy(`destination occupée : ${to}`);
        // Course résiduelle : Node n'offre pas de renommage atomique sans remplacement sur macOS.
        // Un fichier créé entre le lstat ci-dessus et le rename serait écrasé ; la fenêtre est de
        // quelques microsecondes et l'engine revérifie l'état à chaque passe.
        await this.rename(a, b);
    }

    async isUnchanged(rel: string, entry: Entry): Promise<boolean> {
        try {
            const st = await fsp.lstat(this.absolutePath(rel));
            if (`${st.dev}:${st.ino}` !== entry.id && !entry.id.startsWith(`${st.dev}:${st.ino}#`)) return false;
            if (entry.kind === 'dir') return st.isDirectory();
            return st.isFile() && st.size === entry.size && Math.floor(st.mtimeMs) === entry.mtime;
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
            // Autre volume : copie, vérification, puis seulement suppression de l'original.
            await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
            const [a, b] = await Promise.all([treeSize(src), treeSize(dest)]);
            if (a.size !== b.size || a.count !== b.count) throw new Error(`copie en quarantaine incomplète pour ${rel} : original conservé`);
            await fsp.rm(src, { recursive: true });
        }
    }

    async openSource(rel: string): Promise<Source> {
        const st = await fsp.lstat(this.absolutePath(rel));
        if (!st.isFile()) throw new Error(`pas un fichier régulier : ${rel}`);
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
                throw new Error(`empreinte SHA-1 différente pour ${rel} : attendu ${expectedHash}, reçu ${hash}`);
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
                // link() échoue avec EEXIST si la destination existe : aucun écrasement possible.
                await fsp.link(tmp, dest);
            } catch (e) {
                const code = (e as NodeJS.ErrnoException).code;
                if (code === 'EEXIST') throw new PathBusy(`destination déjà occupée : ${rel}`);
                if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw e;
                // Pas de lien physique : repli sur lstat puis rename (petite fenêtre de course).
                try {
                    await fsp.lstat(dest);
                    throw new PathBusy(`destination déjà occupée : ${rel}`);
                } catch (e2) {
                    if (e2 instanceof PathBusy) throw e2;
                }
                await fsp.rename(tmp, dest);
            }
            const st = await fsp.lstat(dest);
            return { id: `${st.dev}:${st.ino}`, parent: ROOT, name: path.basename(rel), kind: 'file', size: st.size, mtime: Math.floor(st.mtimeMs), hash };
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

