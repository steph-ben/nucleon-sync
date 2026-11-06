import * as path from 'node:path';

export const APP_NAME = 'nucleon-sync';
export const VERSION = '0.2.5';
export const CHANNEL: string = 'beta';

/** Sent to Proton in the x-pm-appversion header, in the shape the SDK asks for. */
export const APP_VERSION = appVersionFor(VERSION, CHANNEL);

/** Release version as tagged on GitHub: 0.2.0-beta, or 0.2.0 for a stable release. */
export const RELEASE_VERSION = CHANNEL === 'stable' ? VERSION : `${VERSION}-${CHANNEL}`;

/** What `nucleon-sync version` prints for a release version such as 0.3.0-beta or 0.3.0. */
export function releaseAppVersion(release: string): string {
    const [numbers = '', channel = 'stable'] = release.split(/-(.*)/s);
    return appVersionFor(numbers, channel);
}

function appVersionFor(version: string, channel: string): string {
    return `external-drive-nucleon_sync@${version}-${channel}`;
}

export const THIRD_PARTY_NOTICE = 'This is a third-party application not officially supported by Proton.';

/** Data folder: NUCLEON_SYNC_HOME, else the deprecated PROTON_SYNC_HOME, else ~/.local/share/nucleon-sync. */
export function dataDir(env: Record<string, string | undefined>, home: string): string {
    return env.NUCLEON_SYNC_HOME ?? env.PROTON_SYNC_HOME ?? path.join(home, '.local/share', APP_NAME);
}

export const ROOT_MARKER = '.nucleon-sync-root';
export const TMP_DIR = '.nucleon-sync-tmp';
export const SWAP_PREFIX = '.nucleon-sync-swap-';

/** Names written by proton-sync, still accepted so existing folders keep working. */
export const LEGACY_ROOT_MARKER = '.proton-sync-root';
export const LEGACY_TMP_DIR = '.proton-sync-tmp';

/** Config file: NUCLEON_SYNC_CONFIG, else the deprecated PROTON_SYNC_CONFIG, else config.json in the data folder. */
export function configFile(env: Record<string, string | undefined>, dir: string): string {
    return env.NUCLEON_SYNC_CONFIG ?? env.PROTON_SYNC_CONFIG ?? path.join(dir, 'config.json');
}
