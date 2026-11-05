/**
 * Proves the tests can fail: breaks one safeguard at a time, on a temporary copy, and expects the
 * tests to turn red. A surviving mutant is a safeguard no test protects. Never touches the working tree.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

interface Mutant {
    name: string;
    file: string;
    from: string;
    to: string;
    /** Only observable on a case-insensitive disk. */
    needsCaseInsensitiveDisk?: boolean;
}

const E = 'src/core/engine.ts';
const R = 'src/core/reconcile.ts';
const L = 'src/adapters/local.ts';
const P = 'src/adapters/proton.ts';

const MUTANTS: Mutant[] = [
    { name: 'no permanent deletion in the API', file: P, from: "    | 'trashNodes'\n", to: "    | 'trashNodes'\n    | 'deleteNodes'\n" },
    { name: 'quarantine really deletes', file: L, from: 'await this.rename(src, dest);', to: 'await fsp.rm(src, { recursive: true });' },
    { name: 'quarantine across volumes skips verification', file: L, from: 'if (a.size !== b.size || a.count !== b.count) throw', to: 'if (false) throw' },
    { name: 'download hash check removed', file: L, from: 'if (expectedHash !== undefined && hash !== expectedHash) {', to: 'if (false) {' },
    { name: 'install overwrites the destination', file: L, from: 'await fsp.link(tmp, dest);', to: 'await fsp.rename(tmp, dest);' },
    { name: 'local move replaces the destination', file: L, from: 'if (dst && !(dst.dev === src.dev && dst.ino === src.ino && a !== b)) throw new PathBusy(`destination busy: ${to}`);', to: '' },
    { name: 'item not rechecked before a local action', file: L, from: 'async isUnchanged(rel: string, entry: Entry): Promise<boolean> {\n', to: 'async isUnchanged(rel: string, entry: Entry): Promise<boolean> {\n        return true;\n' },
    { name: 'root marker not required', file: L, from: 'throw new Error(`marker ${ROOT_MARKER} missing from ${this.root}: root not trusted`);', to: '' },
    { name: 'empty local scan accepted', file: E, from: "if (base.length >= EMPTY_GUARD_MIN && this.L.size === 0) throw new SafetyStop('local folder is empty but the base is not');", to: '' },
    { name: 'empty Drive accepted', file: E, from: "if (base.length >= EMPTY_GUARD_MIN && this.R.size === 0) throw new SafetyStop('Drive is empty but the base is not');", to: '' },
    { name: 'deletion limit removed', file: R, from: 'const overLimit = deletedFiles > o.maxDeletes && !o.approveDeletes;', to: 'const overLimit = false;' },
    { name: 'incomplete scan does not block deletions', file: E, from: 'blockDeletes: unread.length > 0', to: 'blockDeletes: false' },
    { name: 'unreadable folder not reported', file: L, from: 'this.scanWarnings.push(`cannot read folder: ${rel || \'.\'} (${(e as Error).message})`);', to: '' },
    { name: 'unreadable file not reported', file: L, from: 'this.scanWarnings.push(`cannot read: ${childRel} (${(e as Error).message})`);', to: '' },
    { name: 'deletions continue after an error', file: E, from: "if (hardFailure && (a.t === 'remoteTrash' || a.t === 'localQuarantine')) {", to: 'if (false) {' },
    { name: 'Proton documents not protected', file: P, from: 'protected: !nameOk || native || !(isFile || isFolder),', to: 'protected: false,' },
    { name: 'folder holding a document can be trashed', file: E, from: 'if (this.holdsSomethingAlive(this.R, rec.remoteId, (e) => this.recByRemote(e.id))) return false;', to: '' },
    { name: 'symlinks followed as files', file: L, from: 'if (!isDir && !st.isFile()) continue; // symlink or special file: never followed', to: '' },
    { name: 'conflict keeps one version', file: R, from: 'if (s.lMod && s.rMod && !(s.l!.hash && s.l!.hash === s.r!.hash)) {', to: 'if (false) {' },
    { name: 'same-size edits unseen', file: L, from: '(k.localCtime === undefined || k.localCtime === ctime)', to: 'true' },
    { name: 'stale file record taken as parent', file: E, from: "if (r.kind !== 'dir') continue;", to: '' },
    { name: 'partial Drive walk replaces the view', file: P, from: 'this.entries = previous;\n            throw e;', to: 'throw e;' },
    { name: 'case-only names not seen as busy', file: E, from: "return this.options.caseInsensitive ? n.toLowerCase() : n;", to: 'return n;', needsCaseInsensitiveDisk: true },
];

const repo = path.join(import.meta.dir, '..');
const copy = mkdtempSync(path.join(tmpdir(), 'proton-sync-mutants-'));
for (const p of ['src', 'test', 'package.json', 'tsconfig.json']) cpSync(path.join(repo, p), path.join(copy, p), { recursive: true });
symlinkSync(path.join(repo, 'node_modules'), path.join(copy, 'node_modules'));
symlinkSync(path.join(repo, 'vendor'), path.join(copy, 'vendor'));
const SUITE = ['test/local.test.ts', 'test/scenarios.test.ts', 'test/integration.test.ts', 'test/proton-adapter.test.ts', 'test/journal.test.ts', 'test/catalog'];

async function testsPass() {
    const p = Bun.spawn([process.execPath, 'test', '--bail', ...SUITE], { cwd: copy, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, CATALOG_OUT: '' } });
    return (await p.exited) === 0;
}

let survivors = 0;
try {
    if (!(await testsPass())) throw new Error('the suite is red before any mutation');
    const mutants = MUTANTS.filter((m) => !m.needsCaseInsensitiveDisk || process.platform === 'darwin');
    for (const m of mutants) {
        const file = path.join(copy, m.file);
        const original = readFileSync(file, 'utf8');
        if (!original.includes(m.from)) throw new Error(`mutant no longer applies: ${m.name}`);
        writeFileSync(file, original.replace(m.from, m.to));
        const survived = await testsPass();
        writeFileSync(file, original);
        console.log(`${survived ? 'SURVIVED' : 'caught  '}  ${m.name}`);
        if (survived) survivors++;
    }
    console.log(`${mutants.length - survivors}/${mutants.length} caught`);
} finally {
    rmSync(copy, { recursive: true, force: true });
}
process.exit(survivors ? 1 : 0);
