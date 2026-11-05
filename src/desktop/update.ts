import type { Note } from './state';

export type CiResult = 'success' | 'failure' | 'unknown';

export function decideUpdate(s: { branch: string; behind: number; clean: boolean; ci: CiResult }): 'none' | 'install' | 'signal' {
    if (s.branch !== 'main' || s.behind === 0) return 'none';
    return s.clean && s.ci === 'success' ? 'install' : 'signal';
}

function run(cwd: string, ...cmd: string[]) {
    const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
}

/** CI verdict of a commit. Unknown without `gh`: the repository is private. */
function ciOf(repo: string, sha: string): CiResult {
    if (!Bun.which('gh')) return 'unknown';
    const r = run(repo, 'gh', 'run', 'list', '--workflow', 'CI', '--commit', sha, '--limit', '1', '--json', 'conclusion', '--jq', '.[0].conclusion');
    if (!r.ok || !r.out) return 'unknown';
    return r.out === 'success' ? 'success' : 'failure';
}

/** Only ever fast-forwards. Returns what happened, in words. */
export function checkForUpdate(repo: string, notify: (n: Note) => void, restart: () => void): string {
    if (!run(repo, 'git', 'fetch', '--quiet', 'origin', 'main').ok) return 'no update check: origin not reachable';
    const branch = run(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD').out;
    const behind = Number(run(repo, 'git', 'rev-list', '--count', 'HEAD..origin/main').out) || 0;
    const clean = run(repo, 'git', 'status', '--porcelain').out === '';
    const sha = run(repo, 'git', 'rev-parse', 'origin/main').out;
    const decision = decideUpdate({ branch, behind, clean, ci: ciOf(repo, sha) });
    if (decision === 'none') return 'up to date';
    if (decision === 'signal') {
        notify({ title: 'nucleon-sync: update available', body: `${behind} commit(s) on main. Install them by hand.` });
        return 'update available, not installed';
    }
    if (!run(repo, 'git', 'merge', '--ff-only', 'origin/main').ok) return 'update failed: not a fast-forward';
    if (!run(repo, 'bash', 'scripts/install.sh').ok) {
        notify({ title: 'nucleon-sync: update incomplete', body: 'Run scripts/install.sh.' });
        return 'update merged, install failed';
    }
    restart();
    notify({ title: 'nucleon-sync updated', body: `${behind} commit(s) installed.` });
    return 'updated';
}
