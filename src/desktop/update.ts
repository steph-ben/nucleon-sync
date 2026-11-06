import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseAppVersion } from '../names';
import type { Note } from './state';

const REPO_API = 'https://api.github.com/repos/steph-ben/nucleon-sync/releases';
const NETWORK_TIMEOUT_MS = 15_000;
const VERSION_FORMAT = /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/;

type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown>; text?(): Promise<string> }>;

function withTimeout<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS).unref())]);
}

/** Positive when a is newer than b. "0.2.0-beta" is older than "0.2.0", numbers compare as numbers. */
export function compareVersions(a: string, b: string): number {
    const [numbersA = '', suffixA = ''] = a.split(/-(.*)/s);
    const [numbersB = '', suffixB = ''] = b.split(/-(.*)/s);
    const partsA = numbersA.split('.').map(Number);
    const partsB = numbersB.split('.').map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const difference = (partsA[i] ?? 0) - (partsB[i] ?? 0);
        if (difference !== 0) return difference;
    }
    if (suffixA === suffixB) return 0;
    if (suffixA === '') return 1;
    if (suffixB === '') return -1;
    return suffixA.localeCompare(suffixB, 'en', { numeric: true });
}

export function decideUpdate(s: { current: string; latest: string | undefined }): 'none' | 'install' {
    if (!s.latest || !VERSION_FORMAT.test(s.latest)) return 'none';
    return compareVersions(s.latest, s.current) > 0 ? 'install' : 'none';
}

/** Newest release version, or undefined without network or with an answer we do not understand. */
export async function fetchLatest(current: string, fetchUrl: Fetch): Promise<string | undefined> {
    // GitHub's "latest" skips prereleases, and the first releases are betas.
    const url = current.includes('-beta') ? `${REPO_API}?per_page=1` : `${REPO_API}/latest`;
    try {
        const response = await withTimeout(fetchUrl(url));
        if (!response.ok) return undefined;
        const body = await withTimeout(response.json());
        const release = Array.isArray(body) ? body[0] : body;
        const tag = (release as { tag_name?: unknown } | undefined)?.tag_name;
        if (typeof tag !== 'string') return undefined;
        const version = tag.replace(/^v/, '');
        return VERSION_FORMAT.test(version) ? version : undefined;
    } catch {
        return undefined;
    }
}

/** True when the code runs from app/versions/<v>, as put there by install.sh (not from a developer checkout). */
export function isInstalledLayout(codeDir: string, appDir: string): boolean {
    try {
        return realpathSync(codeDir).startsWith(path.join(realpathSync(appDir), 'versions') + path.sep);
    } catch {
        return false;
    }
}

function pointCurrentTo(appDir: string, target: string) {
    const temporary = path.join(appDir, '.current-new');
    rmSync(temporary, { force: true });
    symlinkSync(target, temporary);
    renameSync(temporary, path.join(appDir, 'current'));
}

/** Moves "current" to the version, checks that it works, and puts the previous link back if not. */
export function switchVersion(appDir: string, version: string, healthy: () => boolean): 'switched' | 'rolled-back' {
    const previous = readlinkSync(path.join(appDir, 'current'));
    pointCurrentTo(appDir, `versions/${version}`);
    let ok = false;
    try {
        ok = healthy();
    } catch {
        ok = false;
    }
    if (ok) return 'switched';
    pointCurrentTo(appDir, previous);
    return 'rolled-back';
}

/** Keeps the current and the previous version, deletes older folders in app/versions. */
function pruneVersions(appDir: string, keep: string[]) {
    const versionsDir = path.join(appDir, 'versions');
    for (const name of readdirSync(versionsDir)) {
        if (!keep.includes(name)) rmSync(path.join(versionsDir, name), { recursive: true, force: true });
    }
}

export type UpdateDeps = {
    appDir: string;
    /** Folder of the running code, to tell an installed program from a developer checkout. */
    codeDir: string;
    current: string;
    fetch: Fetch;
    run: (cmd: string[], env?: Record<string, string>) => number;
    /** Standard output of a command, empty if it failed. */
    output: (cmd: string[]) => string;
    /** False when no systemd unit or launchd agent is installed: there is nothing to restart. */
    serviceInstalled: () => boolean;
    /** Restarts the service. True when the restart command succeeded. */
    restart: () => boolean;
    /** True when the service is running. */
    serviceIsActive: () => boolean;
    /** Lets the new version run a few seconds before checking the service. */
    wait: () => Promise<void>;
};

/** Name of the version folder the code runs from: the segment after "versions" in its real path. */
export function runningVersion(codeDir: string): string | undefined {
    try {
        const parts = realpathSync(codeDir).split(path.sep);
        const at = parts.lastIndexOf('versions');
        return at >= 0 ? parts[at + 1] : undefined;
    } catch {
        return undefined;
    }
}

function isSymlink(file: string): boolean {
    try {
        return lstatSync(file).isSymbolicLink();
    } catch {
        return false;
    }
}

/** A broken leftover would make install.sh skip this version next time. Never the running or previous one. */
function removeVersion(appDir: string, version: string, protectedVersions: string[]) {
    if (!protectedVersions.includes(version)) rmSync(path.join(appDir, 'versions', version), { recursive: true, force: true });
}

export async function runUpdate(d: UpdateDeps): Promise<string> {
    if (!isInstalledLayout(d.codeDir, d.appDir) || !isSymlink(path.join(d.appDir, 'current'))) {
        return 'nucleon-sync is not installed with install.sh (developer checkout): update with git.';
    }
    const latest = await fetchLatest(d.current, d.fetch);
    if (!latest) return 'no update check';
    if (decideUpdate({ current: d.current, latest }) === 'none') return 'up to date';

    const previousLink = readlinkSync(path.join(d.appDir, 'current'));
    const previous = path.basename(previousLink);
    const keep = [previous, runningVersion(d.codeDir) ?? previous];
    // A leftover of an earlier failed update would be skipped by install.sh too.
    removeVersion(d.appDir, latest, keep);
    const installerUrl = `https://github.com/steph-ben/nucleon-sync/releases/download/v${latest}/install.sh`;
    const installer = await downloadText(d.fetch, installerUrl);
    if (installer === undefined) return `update failed: could not download ${installerUrl}`;
    const folder = mkdtempSync(path.join(tmpdir(), 'nucleon-update-'));
    try {
        const file = path.join(folder, 'install.sh');
        writeFileSync(file, installer);
        // Unpacks the new version next to the old one, without moving "current".
        if (d.run(['sh', file], { NUCLEON_SWITCH: '0' }) !== 0) return `update failed: the installer of ${latest} failed. Nothing changed.`;
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }

    const command = path.join(d.appDir, 'versions', latest, 'bin', 'nucleon-sync');
    const result = switchVersion(d.appDir, latest, () => d.output([command, 'version']).trim() === releaseAppVersion(latest));
    if (result === 'rolled-back') {
        removeVersion(d.appDir, latest, keep);
        return `update failed: ${latest} does not start, rolled back to ${previous}.`;
    }
    if (!d.serviceInstalled()) {
        pruneVersions(d.appDir, [latest, previous]);
        return `updated to ${latest}. No service is installed, so nothing was restarted.`;
    }
    if (!d.restart() || (await d.wait(), !d.serviceIsActive())) {
        pointCurrentTo(d.appDir, previousLink);
        removeVersion(d.appDir, latest, keep);
        if (!d.restart()) return `update failed: the service did not stay up with ${latest}. The link is back on ${previous}, but the service could not be restarted: run the restart command by hand (systemctl --user restart nucleon-sync.service, or launchctl kickstart -k gui/$(id -u)/org.nucleonsync.daemon).`;
        return `update failed: the service did not stay up with ${latest}, rolled back to ${previous}.`;
    }
    pruneVersions(d.appDir, [latest, previous]);
    return `updated to ${latest}`;
}

/** True for the answers of runUpdate that must end the command with an error. */
export function updateFailed(message: string): boolean {
    return message.startsWith('update failed') || message === 'no update check';
}

async function downloadText(fetchUrl: Fetch, url: string): Promise<string | undefined> {
    try {
        const response = await withTimeout(fetchUrl(url));
        return response.ok && response.text ? await withTimeout(response.text()) : undefined;
    } catch {
        return undefined;
    }
}

export type CheckDeps = { current: string; fetch: Fetch; notify: (n: Note) => void; notifiedFile: string };

/** The daily check only tells the user, once per new version. It never installs. */
export async function checkForUpdate(d: CheckDeps): Promise<string> {
    const latest = await fetchLatest(d.current, d.fetch);
    if (!latest) return 'no update check';
    if (decideUpdate({ current: d.current, latest }) === 'none') return 'up to date';
    const alreadyTold = existsSync(d.notifiedFile) && readFileSync(d.notifiedFile, 'utf8') === latest;
    if (!alreadyTold) {
        d.notify({ title: 'nucleon-sync', body: 'update available: run nucleon-sync update' });
        mkdirSync(path.dirname(d.notifiedFile), { recursive: true });
        writeFileSync(d.notifiedFile, latest);
    }
    return 'update available';
}
