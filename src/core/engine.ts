import { type LocalFs, PathBusy, type RemoteFs, type Store } from './interfaces';
import { reconcile } from './reconcile';
import { type Action, type BaseRec, type Entry, ROOT, type Plan, type ReconcileOptions, type Ref, type Snapshot, SWAP_PREFIX } from './types';

export interface CycleResult {
    plan: Plan;
    done: number;
    skipped: number;
    errors: string[];
}

export class SafetyStop extends Error {}


export class Engine {
    private recs = new Map<string, BaseRec>();
    private L: Snapshot = new Map();
    private R: Snapshot = new Map();
    private seq = 0;
    private doomed = new Set<string>();
    private pendingMoves = new Set<string>();

    constructor(
        private local: LocalFs,
        private remote: RemoteFs,
        private store: Store,
        private options: Omit<ReconcileOptions, 'today'> & { newKey: () => string; today: () => string; log?: (s: string) => void; isFatal?: (e: unknown) => boolean; emptyGuardMin?: number },
    ) {}

    async planOnly(approveDeletes = false): Promise<Plan> {
        await this.load();
        return reconcile([...this.recs.values()], this.L, this.R, { ...this.options, today: this.options.today(), approveDeletes });
    }

    /** Une passe : recharge l'état réel, planifie, exécute. Reprendre après coupure = relancer. */
    async cycle(approveDeletes = false): Promise<CycleResult> {
        const plan = await this.planOnly(approveDeletes);
        for (const b of plan.rebinds) {
            const rec = this.recs.get(b.key)!;
            // Nouveau nœud distant : sa révision reste à comparer, même après une coupure.
            this.save({ ...rec, localId: b.localId, remoteId: b.remoteId, rev: b.remoteId === rec.remoteId ? rec.rev : undefined });
        }
        this.pendingMoves = new Set(plan.actions.flatMap((a) => (a.t === 'remoteMove' || a.t === 'localMove' ? [a.key] : [])));
        this.doomed = new Set(plan.actions.flatMap((a) => (a.t === 'remoteTrash' || a.t === 'localQuarantine' || (a.t === 'forget' && a.ifGone) ? [a.key] : [])));
        let done = 0;
        let skipped = 0;
        let hardFailure = false;
        const errors: string[] = [];
        const guarded = async (run: () => Promise<boolean>) => {
            try {
                if (await run()) done++;
                else skipped++;
            } catch (e) {
                if (this.options.isFatal?.(e)) throw e;
                if (!(e instanceof PathBusy)) hardFailure = true;
                errors.push(e instanceof Error ? e.message : String(e));
            }
        };
        const moves: Action[] = [];
        const flushMoves = async () => {
            if (moves.length) {
                const batch = moves.splice(0);
                await guarded(async () => {
                    await this.runMoves(batch);
                    return true;
                });
            }
        };
        for (const a of plan.actions) {
            if (a.t === 'remoteMove' || a.t === 'localMove') {
                moves.push(a);
                continue;
            }
            await flushMoves();
            // Après une vraie erreur, on ne supprime rien : un élément à sauver a pu rester dedans.
            if (hardFailure && (a.t === 'remoteTrash' || a.t === 'localQuarantine')) {
                skipped++;
                continue;
            }
            await guarded(() => this.apply(a));
        }
        await flushMoves();
        return { plan, done, skipped, errors };
    }

    private async load() {
        await this.local.assertRootSafe();
        const base = this.store.all();
        this.recs = new Map(base.map((r) => [r.key, { ...r }]));
        const byLocal = new Map(base.map((r) => [r.localId, r]));
        // En dessous, vider un tout petit dossier est un geste normal, pas une panne.
        const EMPTY_GUARD_MIN = this.options.emptyGuardMin ?? 5;
        this.L = await this.local.scan(byLocal);
        this.R = await this.remote.snapshot();
        if (base.length >= EMPTY_GUARD_MIN && this.L.size === 0) throw new SafetyStop('dossier local vide alors que la base ne l’est pas');
        if (base.length >= EMPTY_GUARD_MIN && this.R.size === 0) throw new SafetyStop('Drive vide alors que la base ne l’est pas');
    }

    private path(id: string): string {
        const parts: string[] = [];
        let guard = 0;
        for (let c = id; c !== ROOT; ) {
            const e = this.L.get(c);
            if (!e || guard++ > 10000) throw new Error(`chemin local introuvable pour ${id}`);
            parts.unshift(e.name);
            c = e.parent;
        }
        return parts.join('/');
    }

    private resolve(ref: Ref): { key: string; localId: string; remoteId: string } {
        if (ref.t === 'root') return { key: ROOT, localId: ROOT, remoteId: ROOT };
        for (const r of this.recs.values()) {
            const hit = ref.t === 'rec' ? r.key === ref.key : ref.t === 'newLocal' ? r.localId === ref.id : r.remoteId === ref.id;
            if (hit) return { key: r.key, localId: r.localId, remoteId: r.remoteId };
        }
        // Le parent dépend d'une action bloquée plus haut : à reprendre à la passe suivante.
        throw new PathBusy(`parent non résolu : ${JSON.stringify(ref)}`);
    }

    private save(rec: BaseRec) {
        this.recs.set(rec.key, rec);
        this.store.put(rec);
    }

    private drop(key: string) {
        this.recs.delete(key);
        this.store.remove(key);
    }

    private makeRec(l: Entry, r: Entry, parentKey: string, name: string): BaseRec {
        return { key: this.options.newKey(), parent: parentKey, name, kind: l.kind, localId: l.id, remoteId: r.id, hash: l.hash, size: l.size, localMtime: l.mtime, rev: r.rev };
    }

    private async apply(a: Action): Promise<boolean> {
        switch (a.t) {
            case 'conflictRename': {
                const e = this.L.get(a.localId)!;
                const dir = e.parent === ROOT ? '' : `${this.path(e.parent)}/`;
                await this.local.move(this.path(e.id), `${dir}${a.newName}`);
                e.name = a.newName;
                return true;
            }
            case 'forget':
                if (a.ifGone && this.recs.has(a.ifGone)) return false;
                this.drop(a.key);
                return true;
            case 'link': {
                const l = this.L.get(a.localId)!;
                const r = this.R.get(a.remoteId)!;
                const parent = this.parentKey(l.parent);
                this.save(this.makeRec(l, r, parent, r.name));
                return true;
            }
            case 'remoteMkdir': {
                const p = this.resolve(a.parent);
                const l = this.L.get(a.localId)!;
                await this.vacateRemote(p.remoteId, a.name);
                const r = await this.remote.mkdir(p.remoteId, a.name);
                this.R.set(r.id, r);
                this.save(this.makeRec(l, r, p.key, a.name));
                return true;
            }
            case 'localMkdir': {
                const p = this.resolve(a.parent);
                const r = this.R.get(a.remoteId)!;
                await this.vacateLocal(p.localId, a.name);
                const dir = p.localId === ROOT ? a.name : `${this.path(p.localId)}/${a.name}`;
                const l = await this.local.mkdir(dir);
                l.parent = p.localId;
                this.L.set(l.id, l);
                this.save(this.makeRec(l, r, p.key, a.name));
                return true;
            }
            case 'upload': {
                const p = this.resolve(a.parent);
                const l = this.L.get(a.localId)!;
                const path = this.path(l.id);
                const src = await this.local.openSource(path);
                const r = await this.remote.upload(p.remoteId, a.name, path, src, l.hash);
                this.R.set(r.id, r);
                this.save(this.makeRec(l, r, p.key, a.name));
                return true;
            }
            case 'uploadRevision': {
                const rec = this.recs.get(a.key)!;
                const l = this.currentLocal(rec);
                const path = this.path(l.id);
                const src = await this.local.openSource(path);
                const r = await this.remote.uploadRevision(rec.remoteId, path, src, l.hash);
                this.R.set(r.id, r);
                this.save({ ...rec, localId: l.id, hash: l.hash, size: l.size, localMtime: l.mtime, rev: r.rev });
                return true;
            }
            case 'download': {
                const p = this.resolve(a.parent);
                const r = this.R.get(a.remoteId)!;
                const path = p.localId === ROOT ? a.name : `${this.path(p.localId)}/${a.name}`;
                const l = await this.local.writeFile(path, r.hash, r.mtime, (tmp) => this.remote.download(r.id, tmp));
                l.parent = p.localId;
                this.L.set(l.id, l);
                this.save(this.makeRec(l, r, p.key, a.name));
                return true;
            }
            case 'downloadRevision': {
                const rec = this.recs.get(a.key)!;
                const old = this.currentLocal(rec);
                const r = this.currentRemote(rec);
                const path = this.path(old.id);
                if (!(await this.local.isUnchanged(path, old))) return false;
                // L'ancienne version ne bouge qu'une fois la nouvelle complète : une coupure ne coûte rien.
                const l = await this.local.writeFile(
                    path,
                    r.hash,
                    r.mtime,
                    (tmp) => this.remote.download(r.id, tmp),
                    async () => {
                        if (!(await this.local.isUnchanged(path, old))) throw new PathBusy(`modifié pendant le téléchargement : ${path}`);
                        await this.local.quarantine(path);
                    },
                );
                l.parent = old.parent;
                this.L.delete(old.id);
                this.L.set(l.id, l);
                this.save({ ...rec, localId: l.id, remoteId: r.id, hash: l.hash, size: l.size, localMtime: l.mtime, rev: r.rev });
                return true;
            }
            case 'refresh': {
                const rec = this.recs.get(a.key)!;
                const l = this.currentLocal(rec);
                const r = this.currentRemote(rec);
                // Un nom temporaire ne doit jamais entrer dans la base.
                const name = r.name.startsWith(SWAP_PREFIX) || l.name.startsWith(SWAP_PREFIX) ? rec.name : r.name;
                const position = { ...rec, parent: this.parentKey(l.parent), name, localId: l.id, remoteId: r.id };
                this.save(a.content ? { ...position, hash: l.hash, size: l.size, localMtime: l.mtime, rev: r.rev } : position);
                return true;
            }
            case 'remoteTrash': {
                const rec = this.recs.get(a.key)!;
                if (this.holdsSomethingAlive(this.R, rec.remoteId, (e) => this.recByRemote(e.id))) return false;
                await this.remote.trash(rec.remoteId);
                this.drop(rec.key);
                return true;
            }
            case 'localQuarantine': {
                const rec = this.recs.get(a.key)!;
                const l = this.currentLocal(rec);
                const path = this.path(l.id);
                if (l.kind === 'file' && !(await this.local.isUnchanged(path, l))) return false;
                if (this.holdsSomethingAlive(this.L, l.id, (e) => this.recByLocal(e.id))) return false;
                await this.local.quarantine(path);
                this.drop(rec.key);
                return true;
            }
            default:
                throw new Error(`action inconnue ${(a as Action).t}`);
        }
    }

    /** Dernier filet : un dossier ne part que si tout son contenu actuel est promis à la suppression. */
    private holdsSomethingAlive(snap: Snapshot, id: string, recOf: (e: Entry) => BaseRec | undefined): boolean {
        for (const e of snap.values()) {
            if (e.parent !== id) continue;
            if (e.protected) return true;
            const rec = recOf(e);
            if (!rec || !this.doomed.has(rec.key)) return true;
            if (this.holdsSomethingAlive(snap, e.id, recOf)) return true;
        }
        return false;
    }

    private recByRemote(id: string) {
        for (const r of this.recs.values()) if (r.remoteId === id) return r;
        return undefined;
    }

    private recByLocal(id: string) {
        for (const r of this.recs.values()) if (r.localId === id) return r;
        return undefined;
    }

    private canVacate(key: string) {
        return this.pendingMoves.has(key) || this.doomed.has(key);
    }

    /** Le nom est tenu par un élément sur le point d'aller ailleurs : il cède la place. */
    private async vacateRemote(parentId: string, name: string) {
        for (const e of this.R.values()) {
            const rec = e.parent === parentId && e.name.normalize('NFC') === name.normalize('NFC') ? this.recByRemote(e.id) : undefined;
            if (!rec || !this.canVacate(rec.key)) continue;
            const moved = await this.remote.move(e.id, e.parent, `${SWAP_PREFIX}${this.options.deviceName}-${++this.seq}`);
            this.R.set(moved.id, moved);
        }
    }

    private async vacateLocal(parentId: string, name: string) {
        for (const e of this.L.values()) {
            const rec = e.parent === parentId && e.name.normalize('NFC') === name.normalize('NFC') ? this.recByLocal(e.id) : undefined;
            if (!rec || !this.canVacate(rec.key)) continue;
            const from = this.path(e.id);
            const tmp = `${SWAP_PREFIX}${this.options.deviceName}-${++this.seq}`;
            await this.local.move(from, parentId === ROOT ? tmp : `${this.path(parentId)}/${tmp}`);
            e.name = tmp;
        }
    }

    private parentKey(localParent: string): string {
        if (localParent === ROOT) return ROOT;
        for (const r of this.recs.values()) if (r.localId === localParent) return r.key;
        throw new Error(`parent sans enregistrement : ${localParent}`);
    }

    private currentLocal(rec: BaseRec): Entry {
        const e = this.L.get(rec.localId);
        if (!e) throw new Error(`élément local absent : ${rec.name}`);
        return e;
    }

    private currentRemote(rec: BaseRec): Entry {
        const e = this.R.get(rec.remoteId);
        if (!e) throw new Error(`élément distant absent : ${rec.name}`);
        return e;
    }

    /** Exécute les déplacements dans un ordre sûr. Un échange a <-> b passe par un nom temporaire. */
    private async runMoves(moves: Action[]) {
        const pending = [...moves] as Extract<Action, { t: 'remoteMove' | 'localMove' }>[];
        const occupied = (a: (typeof pending)[number], parent: { localId: string; remoteId: string }) => {
            const snap = a.t === 'remoteMove' ? this.R : this.L;
            const pid = a.t === 'remoteMove' ? parent.remoteId : parent.localId;
            const self = a.t === 'remoteMove' ? this.recs.get(a.key)!.remoteId : this.recs.get(a.key)!.localId;
            for (const e of snap.values()) if (e.id !== self && e.parent === pid && e.name.normalize('NFC') === a.name.normalize('NFC')) return e;
            return undefined;
        };
        // Inversion parent/enfant : l'enfant doit sortir avant que le parent entre dedans.
        const inOwnSubtree = (a: (typeof pending)[number], parent: { localId: string; remoteId: string }) => {
            const snap = a.t === 'remoteMove' ? this.R : this.L;
            const self = a.t === 'remoteMove' ? this.recs.get(a.key)!.remoteId : this.recs.get(a.key)!.localId;
            let guard = 0;
            for (let c = a.t === 'remoteMove' ? parent.remoteId : parent.localId; c !== ROOT && guard++ < 10000; c = snap.get(c)?.parent ?? ROOT) if (c === self) return true;
            return false;
        };
        while (pending.length) {
            let progressed = false;
            for (const a of [...pending]) {
                const p = this.resolve(a.parent);
                if (occupied(a, p) || inOwnSubtree(a, p)) continue;
                await this.applyMove(a, p);
                pending.splice(pending.indexOf(a), 1);
                progressed = true;
            }
            if (progressed) continue;
            // Rien ne passe : libérer le premier nom tenu par un élément qui doit partir.
            let freed = false;
            for (const a of pending) {
                const p = this.resolve(a.parent);
                const blocker = occupied(a, p);
                if (!blocker) continue;
                const blockerRec = a.t === 'remoteMove' ? this.recByRemote(blocker.id) : this.recByLocal(blocker.id);
                if (!blockerRec || !this.canVacate(blockerRec.key)) continue;
                // Le temporaire reste dans le dossier actuel : la cible peut être sous l'élément lui-même.
                if (a.t === 'remoteMove') await this.vacateRemote(p.remoteId, a.name);
                else await this.vacateLocal(p.localId, a.name);
                freed = true;
                break;
            }
            // Occupée par un élément qui ne bouge pas : souvent une suppression, à reprendre ensuite.
            if (!freed) throw new PathBusy(`déplacement impossible pour l'instant : ${pending[0]!.name}`);
        }
    }

    private async applyMove(a: Extract<Action, { t: 'remoteMove' | 'localMove' }>, p: { key: string; localId: string; remoteId: string }) {
        const rec = this.recs.get(a.key)!;
        if (a.t === 'remoteMove') {
            const r = await this.remote.move(rec.remoteId, p.remoteId, a.name);
            this.R.set(r.id, r);
        } else {
            const l = this.currentLocal(rec);
            const to = p.localId === ROOT ? a.name : `${this.path(p.localId)}/${a.name}`;
            await this.local.move(this.path(l.id), to);
            l.parent = p.localId;
            l.name = a.name;
        }
        this.save({ ...rec, parent: p.key, name: a.name });
    }
}
