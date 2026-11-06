import { type Action, type BaseRec, type Entry, type Plan, ROOT, type ReconcileOptions, type Ref, type Snapshot, SWAP_PREFIX } from './types';

const nfc = (s: string) => s.normalize('NFC');

export function conflictName(name: string, device: string, today: string, n = 0): string {
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0 && dot < name.length - 1;
    const stem = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : '';
    return `${stem} (conflict ${device} ${today}${n ? ` ${n}` : ''})${ext}`;
}

interface State {
    rec: BaseRec;
    l?: Entry;
    r?: Entry;
    lMoved: boolean;
    rMoved: boolean;
    lMod: boolean;
    rMod: boolean;
    /** Temporary name left on the Drive by this device during an interruption: to be repaired. */
    ownSwap: boolean;
    /** Same thing on the local side: the item goes back to its place. */
    lSwap: boolean;
}

/** Pure function: no I/O. The only content decision comes from hash and rev. */
export function reconcile(base: BaseRec[], L: Snapshot, R: Snapshot, o: ReconcileOptions): Plan {
    const warnings: string[] = [];
    const nameKey = (n: string) => (o.caseInsensitive ? nfc(n).toLowerCase() : nfc(n));

    const byKey = new Map(base.map((r) => [r.key, r]));
    const depth = (r: BaseRec): number => {
        let d = 0;
        for (let c: BaseRec | undefined = r; c && c.parent !== ROOT && d < 10000; c = byKey.get(c.parent)) d++;
        return d;
    };
    const sorted = [...base].sort((a, b) => depth(a) - depth(b));

    // 1. Bind each record to its item on each side.
    const bindSide = (snap: Snapshot, idOf: (r: BaseRec) => string, trust: (r: BaseRec, e: Entry, parentId: string | undefined) => boolean) => {
        const bound = new Map<string, Entry>();
        const claimed = new Set<string>();
        // An id binds one record only. Two records can hold it when a deleted folder's inode is
        // reused: the record at the item's place goes first, the other one lost its item.
        for (const atPlaceOnly of [true, false]) {
            for (const r of sorted) {
                const e = snap.get(idOf(r));
                const parentId = r.parent === ROOT ? ROOT : bound.get(r.parent)?.id;
                const atPlace = e?.parent === parentId && nameKey(e?.name ?? '') === nameKey(r.name);
                if (e && e.kind === r.kind && !e.protected && !claimed.has(e.id) && (atPlace || !atPlaceOnly) && trust(r, e, parentId)) {
                    bound.set(r.key, e);
                    claimed.add(e.id);
                }
            }
        }
        // Atomic editor save: new id at the same place = same item.
        const index = new Map<string, Entry>();
        for (const e of snap.values()) if (!claimed.has(e.id) && !e.protected) index.set(`${e.parent}|${nameKey(e.name)}`, e);
        for (const r of sorted) {
            if (bound.has(r.key)) continue;
            const parentId = r.parent === ROOT ? ROOT : bound.get(r.parent)?.id;
            if (parentId === undefined) continue;
            const e = index.get(`${parentId}|${nameKey(r.name)}`);
            if (e && e.kind === r.kind) {
                bound.set(r.key, e);
                index.delete(`${parentId}|${nameKey(r.name)}`);
            }
        }
        return bound;
    };
    // An inode can be reused by an unrelated file (at once on Linux). A file found elsewhere with
    // other content is not the same file: a real move keeps its content, an edit keeps its place.
    const sameLocalFile = (r: BaseRec, e: Entry, parentId: string | undefined) => r.kind === 'dir' || r.hash === undefined || e.hash === r.hash || (e.parent === parentId && nameKey(e.name) === nameKey(r.name));
    const boundL = bindSide(L, (r) => r.localId, sameLocalFile);
    const boundR = bindSide(R, (r) => r.remoteId, () => true);

    const recOfL = new Map<string, string>();
    const recOfR = new Map<string, string>();
    for (const [k, e] of boundL) recOfL.set(e.id, k);
    for (const [k, e] of boundR) recOfR.set(e.id, k);

    const movedFrom = (e: Entry, rec: BaseRec, recOf: Map<string, string>) => {
        const p = e.parent === ROOT ? ROOT : (recOf.get(e.parent) ?? '\0new');
        return p !== rec.parent || nfc(e.name) !== nfc(rec.name);
    };

    const states = new Map<string, State>();
    for (const rec of sorted) {
        const l = boundL.get(rec.key);
        const r = boundR.get(rec.key);
        states.set(rec.key, {
            rec,
            l,
            r,
            lMoved: !!l && movedFrom(l, rec, recOfL) && !l.name.startsWith(SWAP_PREFIX),
            lSwap: !!l && l.name.startsWith(SWAP_PREFIX),
            // A transient name left by an interruption is not a user choice.
            rMoved: !!r && movedFrom(r, rec, recOfR) && !r.name.startsWith(SWAP_PREFIX),
            ownSwap: !!r && r.name.startsWith(`${SWAP_PREFIX}${o.deviceName}-`),
            lMod: !!l && rec.kind === 'file' && l.hash !== rec.hash,
            rMod: !!r && rec.kind === 'file' && (r.rev !== rec.rev || r.id !== rec.remoteId),
        });
    }

    const childrenOf = (snap: Snapshot) => {
        const m = new Map<string, Entry[]>();
        for (const e of snap.values()) {
            const list = m.get(e.parent);
            if (list) list.push(e);
            else m.set(e.parent, [e]);
        }
        return m;
    };
    const kidsL = childrenOf(L);
    const kidsR = childrenOf(R);

    // 2. Deleted on one side: keep it as soon as it carries something alive.
    const buildKeep = (kids: Map<string, Entry[]>, recOf: Map<string, string>, side: 'l' | 'r') => {
        const other = side === 'l' ? 'r' : 'l';
        const memo = new Map<string, boolean>();
        const forced = new Set<string>();
        const force = (e: Entry) => {
            forced.add(e.id);
            for (const c of kids.get(e.id) ?? []) force(c);
        };
        for (const s of states.values()) {
            const e = s[side];
            if (e && !s[other] && (side === 'l' ? s.lMoved : s.rMoved)) force(e);
        }
        const keep = (s: State): boolean => {
            const e = s[side]!;
            const cached = memo.get(s.rec.key);
            if (cached !== undefined) return cached;
            memo.set(s.rec.key, false);
            let result = forced.has(e.id) || (side === 'l' ? s.lMod : s.rMod);
            if (!result && e.kind === 'dir') {
                for (const c of kids.get(e.id) ?? []) {
                    if (c.protected) {
                        result = true;
                        break;
                    }
                    const ck = recOf.get(c.id);
                    const cs = ck ? states.get(ck) : undefined;
                    if (!cs) {
                        result = true;
                        break;
                    }
                    // On a double move, the remote wins: the remote side always keeps its child.
                    const stays = cs[other] ? (side === 'l' ? !cs.rMoved : !(cs.lMoved && !cs.rMoved)) : keep(cs);
                    if (stays) {
                        result = true;
                        break;
                    }
                }
            }
            memo.set(s.rec.key, result);
            return result;
        };
        return keep;
    };
    const keepL = buildKeep(kidsL, recOfL, 'l');
    const keepR = buildKeep(kidsR, recOfR, 'r');

    const earlyForget: Action[] = [];
    const conflicts: Action[] = [];
    const remoteTrash: BaseRec[] = [];
    const quarantine: BaseRec[] = [];
    const gone: Action[] = [];
    /** Items slated for deletion: neither new nor to be re-paired. */
    const doomedL = new Set<string>();
    const doomedR = new Set<string>();
    const swapRepairs: State[] = [];

    /** The record is forgotten: whatever remains on each side becomes a new item again. */
    const release = (s: State) => {
        earlyForget.push({ t: 'forget', key: s.rec.key });
        if (s.l) recOfL.delete(s.l.id);
        if (s.r) recOfR.delete(s.r.id);
        states.delete(s.rec.key);
    };

    for (const s of [...states.values()]) {
        if (!s.l && !s.r) {
            gone.push({ t: 'forget', key: s.rec.key });
            states.delete(s.rec.key);
        } else if (s.l && !s.r) {
            if (keepL(s)) release(s);
            else {
                quarantine.push(s.rec);
                states.delete(s.rec.key);
                recOfL.delete(s.l.id);
                doomedL.add(s.l.id);
            }
        } else if (s.r && !s.l && s.ownSwap) {
            // First give the item its real name back; the normal rules apply on the next pass.
            swapRepairs.push(s);
            states.delete(s.rec.key);
            doomedR.add(s.r.id);
        } else if (s.r && !s.l) {
            if (keepR(s)) release(s);
            else {
                remoteTrash.push(s.rec);
                states.delete(s.rec.key);
                recOfR.delete(s.r.id);
                doomedR.add(s.r.id);
            }
        }
    }

    // 3. Content modified on both sides with different content: both versions survive.
    const refreshes: Action[] = [];
    const contentOps: Action[] = [];
    const renamed = new Map<string, string>();
    for (const s of [...states.values()]) {
        if (s.lMod && s.rMod && !(s.l!.hash && s.l!.hash === s.r!.hash)) {
            const newName = conflictName(s.l!.name, o.deviceName, o.today);
            conflicts.push({ t: 'conflictRename', localId: s.l!.id, newName });
            renamed.set(s.l!.id, newName);
            release(s);
        }
    }

    // 4. Pair new items created at the same place on both sides.
    const newL = () => [...L.values()].filter((e) => !recOfL.has(e.id) && !doomedL.has(e.id) && !e.protected && !linked.has(e.id));
    const linked = new Map<string, string>(); // local -> remote
    const linkedRev = new Map<string, string>(); // remote -> local
    const canonL = (id: string) =>
        id === ROOT ? ROOT : recOfL.has(id) ? `rec:${recOfL.get(id)}` : linked.has(id) ? `link:${id}` : `newL:${id}`;
    const canonR = (id: string) =>
        id === ROOT ? ROOT : recOfR.has(id) ? `rec:${recOfR.get(id)}` : linkedRev.has(id) ? `link:${linkedRev.get(id)}` : `newR:${id}`;
    const nameOfL = (e: Entry) => renamed.get(e.id) ?? e.name;

    const mkdirsAndLinks: { d: number; a: Action }[] = [];
    const entryDepth = (e: Entry, snap: Snapshot): number => {
        let d = 0;
        for (let c: Entry | undefined = e; c && c.parent !== ROOT && d < 10000; c = snap.get(c.parent)) d++;
        return d;
    };

    for (let changed = true; changed; ) {
        changed = false;
        const idx = new Map<string, Entry>();
        for (const e of R.values()) {
            if (recOfR.has(e.id) || doomedR.has(e.id) || e.protected || linkedRev.has(e.id)) continue;
            idx.set(`${canonR(e.parent)}|${nameKey(e.name)}`, e);
        }
        for (const e of newL()) {
            if (renamed.has(e.id)) continue;
            const m = idx.get(`${canonL(e.parent)}|${nameKey(e.name)}`);
            if (!m || m.kind !== e.kind) continue;
            if (e.kind === 'file' && !(e.hash && e.hash === m.hash)) continue;
            linked.set(e.id, m.id);
            linkedRev.set(m.id, e.id);
            mkdirsAndLinks.push({ d: entryDepth(e, L), a: { t: 'link', localId: e.id, remoteId: m.id } });
            changed = true;
        }
    }

    const refL = (id: string): Ref =>
        id === ROOT ? { t: 'root' } : recOfL.has(id) ? { t: 'rec', key: recOfL.get(id)! } : { t: 'newLocal', id };
    const refR = (id: string): Ref =>
        id === ROOT
            ? { t: 'root' }
            : recOfR.has(id)
              ? { t: 'rec', key: recOfR.get(id)! }
              : linkedRev.has(id)
                ? { t: 'newLocal', id: linkedRev.get(id)! }
                : { t: 'newRemote', id };

    // 5. Target position of each surviving item.
    interface Target {
        s: State;
        lWins: boolean; // the local move wins
        parent: string; // canonical form
        name: string;
    }
    const targets = new Map<string, Target>();
    for (const s of states.values()) {
        const lWins = (s.lMoved && !s.rMoved) || s.ownSwap;
        const e = lWins ? (s.lSwap ? undefined : s.l!) : s.rMoved ? s.r! : undefined;
        targets.set(s.rec.key, {
            s,
            lWins,
            parent: e ? (lWins ? canonL(e.parent) : canonR(e.parent)) : s.rec.parent === ROOT ? ROOT : `rec:${s.rec.parent}`,
            name: e ? e.name : s.rec.name,
        });
    }
    // Crossed moves that would form a cycle: the remote wins.
    for (const t of targets.values()) {
        if (!t.lWins || t.s.rec.kind !== 'dir') continue;
        const seen = new Set<string>([t.s.rec.key]);
        for (let p = t.parent; p.startsWith('rec:'); ) {
            const k = p.slice(4);
            if (seen.has(k)) {
                t.lWins = false;
                t.parent = t.s.rec.parent === ROOT ? ROOT : `rec:${t.s.rec.parent}`;
                t.name = t.s.rec.name;
                warnings.push(`move cancelled (cycle): ${t.s.rec.name}`);
                break;
            }
            seen.add(k);
            p = targets.get(k)?.parent ?? ROOT;
        }
    }

    // 6. Target occupancy and name collisions.
    const occ = new Set<string>();
    const slot = (parent: string, name: string) => `${parent}|${nameKey(name)}`;
    for (const t of targets.values()) if (!t.lWins) occ.add(slot(t.parent, t.name));
    for (const [lid, rid] of linked) {
        const r = R.get(rid)!;
        occ.add(slot(canonR(r.parent), r.name));
        void lid;
    }

    const downloads: Action[] = [];
    const newRemoteDirs: { d: number; a: Action }[] = [];
    for (const e of R.values()) {
        if (recOfR.has(e.id) || doomedR.has(e.id) || e.protected || linkedRev.has(e.id)) continue;
        // Temporary name from another device mid-operation: wait until it is done.
        if (e.name.startsWith(SWAP_PREFIX)) continue;
        // A child of an ignored or undecryptable folder stays on the remote side.
        const parent = e.parent === ROOT ? undefined : R.get(e.parent);
        if (parent?.protected) continue;
        const sl = slot(canonR(e.parent), e.name);
        if (occ.has(sl)) {
            warnings.push(`name collision, not downloaded: ${e.name}`);
            continue;
        }
        occ.add(sl);
        if (e.kind === 'dir') newRemoteDirs.push({ d: entryDepth(e, R), a: { t: 'localMkdir', remoteId: e.id, parent: refR(e.parent), name: e.name } });
        else downloads.push({ t: 'download', remoteId: e.id, parent: refR(e.parent), name: e.name });
    }

    const freeName = (parent: string, name: string) => {
        let n = 0;
        let candidate = conflictName(name, o.deviceName, o.today);
        while (occ.has(slot(parent, candidate))) candidate = conflictName(name, o.deviceName, o.today, ++n);
        return candidate;
    };

    const moves: Action[] = [];
    const isNewParent = (a: Action) => 'parent' in a && a.parent.t !== 'root' && a.parent.t !== 'rec';
    const refOfCanon = (canon: string, source: Entry | undefined, fromLocal: boolean): Ref => {
        if (canon === ROOT) return { t: 'root' };
        if (canon.startsWith('rec:')) return { t: 'rec', key: canon.slice(4) };
        if (!source) return { t: 'root' };
        return fromLocal ? refL(source.parent) : refR(source.parent);
    };

    const wouldCycle = (key: string, parent: string) => {
        const seen = new Set<string>();
        for (let p = parent; p.startsWith('rec:') && !seen.has(p); p = targets.get(p.slice(4))?.parent ?? ROOT) {
            if (p.slice(4) === key) return true;
            seen.add(p);
        }
        return false;
    };

    for (const t of targets.values()) {
        const s = t.s;
        if (t.lWins) {
            let name = t.name;
            if (occ.has(slot(t.parent, name))) {
                // Name already taken: it is only a name, the item goes back to its place on the Drive.
                const home = canonR(s.r!.parent);
                if (!s.ownSwap && !occ.has(slot(home, s.r!.name)) && !wouldCycle(s.rec.key, home)) {
                    occ.add(slot(home, s.r!.name));
                    t.parent = home;
                    t.name = s.r!.name;
                    moves.push({ t: 'localMove', key: s.rec.key, parent: refR(s.r!.parent), name: s.r!.name });
                    continue;
                }
                name = freeName(t.parent, name);
                conflicts.push({ t: 'conflictRename', localId: s.l!.id, newName: name });
            }
            occ.add(slot(t.parent, name));
            moves.push({ t: 'remoteMove', key: s.rec.key, parent: refOfCanon(t.parent, s.l, true), name });
        } else if (s.rMoved || s.lMoved || s.lSwap) {
            // The remote wins, or the remote position was kept after a conflict.
            const here = s.l!;
            const samePlace = canonL(here.parent) === t.parent && nfc(here.name) === nfc(t.name);
            if (!samePlace) {
                const source = s.rMoved ? s.r : undefined;
                const parent = source ? refOfCanon(t.parent, source, false) : s.rec.parent === ROOT ? ({ t: 'root' } as Ref) : ({ t: 'rec', key: s.rec.parent } as Ref);
                moves.push({ t: 'localMove', key: s.rec.key, parent, name: t.name });
            } else refreshes.push({ t: 'refresh', key: s.rec.key, content: false });
        }
    }

    for (const s of swapRepairs) {
        const parent = s.rec.parent !== ROOT && states.has(s.rec.parent) ? `rec:${s.rec.parent}` : ROOT;
        const name = occ.has(slot(parent, s.rec.name)) ? freeName(parent, s.rec.name) : s.rec.name;
        occ.add(slot(parent, name));
        moves.push({ t: 'remoteMove', key: s.rec.key, parent: parent === ROOT ? { t: 'root' } : { t: 'rec', key: s.rec.parent }, name });
    }

    // 7. Content of surviving items.
    for (const s of states.values()) {
        if (s.rec.kind !== 'file') continue;
        if (s.lMod && s.rMod) refreshes.push({ t: 'refresh', key: s.rec.key, content: true });
        else if (s.lMod) contentOps.push({ t: 'uploadRevision', key: s.rec.key });
        else if (s.rMod && s.r!.hash && s.r!.hash === s.rec.hash) refreshes.push({ t: 'refresh', key: s.rec.key, content: true });
        else if (s.rMod) contentOps.push({ t: 'downloadRevision', key: s.rec.key });
        else if (s.l!.mtime !== s.rec.localMtime || (s.l!.ctime !== undefined && s.l!.ctime !== s.rec.localCtime)) refreshes.push({ t: 'refresh', key: s.rec.key, content: true });
    }

    // 8. New local items.
    const uploads: Action[] = [];
    const newLocalDirs: { d: number; a: Action }[] = [];
    for (const e of [...newL()].sort((a, b) => entryDepth(a, L) - entryDepth(b, L))) {
        let name = nameOfL(e);
        const parent = canonL(e.parent);
        if (name.startsWith(SWAP_PREFIX)) {
            // Orphan item from an interruption: it keeps its content under a readable name.
            name = freeName(parent, 'recovered');
            conflicts.push({ t: 'conflictRename', localId: e.id, newName: name });
        } else if (occ.has(slot(parent, name))) {
            name = freeName(parent, name);
            conflicts.push({ t: 'conflictRename', localId: e.id, newName: name });
        }
        occ.add(slot(parent, name));
        if (e.kind === 'dir') newLocalDirs.push({ d: entryDepth(e, L), a: { t: 'remoteMkdir', localId: e.id, parent: refL(e.parent), name } });
        else uploads.push({ t: 'upload', localId: e.id, parent: refL(e.parent), name });
    }

    // 9. Deletions: only the topmost item; its descendants are forgotten.
    const compress = (recs: BaseRec[], make: (key: string) => Action) => {
        const keys = new Set(recs.map((r) => r.key));
        const out: Action[] = [];
        // Parent first: after an interruption, orphaned descendants are simply forgotten.
        for (const r of [...recs].sort((a, b) => depth(a) - depth(b))) {
            let top: string | undefined;
            for (let p = byKey.get(r.parent); p; p = byKey.get(p.parent)) if (keys.has(p.key)) top = p.key;
            out.push(top ? { t: 'forget', key: r.key, ifGone: top } : make(r.key));
        }
        return out;
    };
    const deletes = [
        ...compress(remoteTrash, (key) => ({ t: 'remoteTrash', key })),
        ...compress(quarantine, (key) => ({ t: 'localQuarantine', key })),
    ];
    const deletedFiles = [...remoteTrash, ...quarantine].filter((r) => r.kind === 'file').length;
    const overLimit = deletedFiles > o.maxDeletes && !o.approveDeletes;
    const hold = overLimit || !!o.blockDeletes;
    if (o.blockDeletes && deletedFiles) warnings.push(`${deletedFiles} deletions postponed: the local scan is incomplete`);
    else if (overLimit) warnings.push(`${deletedFiles} deletions awaiting approval`);

    const sortByDepth = (l: { d: number; a: Action }[]) => l.sort((a, b) => a.d - b.d).map((x) => x.a);
    const rebinds = sorted
        .map((r) => ({ key: r.key, localId: boundL.get(r.key)?.id ?? r.localId, remoteId: boundR.get(r.key)?.id ?? r.remoteId, r }))
        .filter((b) => b.localId !== b.r.localId || b.remoteId !== b.r.remoteId)
        .map(({ key, localId, remoteId }) => ({ key, localId, remoteId }));
    return {
        rebinds,
        actions: [
            ...conflicts,
            ...earlyForget,
            ...gone,
            // First the moves that free up names, then those targeting a new folder.
            ...moves.filter((a) => !isNewParent(a)),
            ...sortByDepth([...mkdirsAndLinks, ...newLocalDirs, ...newRemoteDirs]),
            ...moves.filter(isNewParent),
            ...uploads,
            ...downloads,
            ...contentOps,
            ...refreshes,
            ...(hold ? [] : deletes),
        ],
        held: hold ? deletes : [],
        heldReason: !deletedFiles ? undefined : o.blockDeletes ? 'incomplete-scan' : overLimit ? 'limit' : undefined,
        warnings,
    };
}
