import * as path from 'node:path';

export const APP_NAME = 'nucleon-sync';
export const VERSION = '0.2.0';
export const CHANNEL = 'beta';

/** Sent to Proton in the x-pm-appversion header, in the shape the SDK asks for. */
export const APP_VERSION = `external-drive-nucleon_sync@${VERSION}-${CHANNEL}`;

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
