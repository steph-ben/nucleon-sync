import { lstatSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { APP_NAME } from './names';

const SERVICES = ['nucleon-sync.service', 'org.nucleonsync.daemon', 'org.nucleonsync.tray'];

/** What uninstall removes: file paths, and "service <name>" entries. Never the synced folder; the data folder only if purging. */
export function planUninstall(home: string, keepData: boolean, data: string = path.join(home, '.local/share', APP_NAME)): string[] {
    const plan = [
        ...SERVICES.map((name) => `service ${name}`),
        path.join(home, '.config/systemd/user/nucleon-sync.service'),
        path.join(home, 'Library/LaunchAgents/org.nucleonsync.daemon.plist'),
        path.join(home, 'Library/LaunchAgents/org.nucleonsync.tray.plist'),
        path.join(home, '.config/autostart/nucleon-sync-tray.desktop'),
        path.join(home, '.local/bin/nucleon-sync'),
        path.join(home, '.local/bin/nucleon-sync-tray'),
        path.join(home, '.local/share', APP_NAME, 'app'),
    ];
    return keepData ? plan : [...plan, data];
}

export type UninstallDeps = {
    home: string;
    /** The data folder really in use: NUCLEON_SYNC_HOME can move it. */
    dataDir: string;
    platform: 'linux' | 'darwin';
    purgeData: boolean;
    /** Path of the synced folder, printed at the end and never touched. */
    syncedFolder: string | undefined;
    ask: (question: string) => Promise<boolean>;
    print: (line: string) => void;
    run: (cmd: string[]) => number;
    /** Removes the saved Proton session from this computer. */
    deleteSession: () => Promise<void>;
};

/** True when `inner` is the same as, or inside, `outer` (symlinks resolved). */
function isInside(inner: string, outer: string): boolean {
    try {
        const resolvedInner = realpathSync(inner);
        const resolvedOuter = realpathSync(outer);
        return resolvedInner === resolvedOuter || resolvedInner.startsWith(resolvedOuter + path.sep);
    } catch {
        return false;
    }
}

function exists(p: string): boolean {
    try {
        lstatSync(p);
        return true;
    } catch {
        return false;
    }
}

/** A command link is ours only if it points into the app folder. */
function isOurLink(link: string, appDir: string): boolean {
    try {
        return readlinkSync(link).startsWith(appDir + path.sep);
    } catch {
        return false;
    }
}

/** Stops the services. Returns the commands to run by hand for those that could not be stopped. */
function stopServices(d: UninstallDeps, services: string[]): string[] {
    const failed: string[] = [];
    const stop = (cmd: string[], absentIsFine: (code: number) => boolean) => {
        const code = d.run(cmd);
        if (code !== 0 && !absentIsFine(code)) failed.push(cmd.join(' '));
    };
    if (d.platform === 'linux') {
        for (const name of services.filter((s) => s.endsWith('.service'))) {
            // No unit file means nothing was installed. If it exists, any failure to stop it is a real failure.
            if (!exists(path.join(d.home, '.config/systemd/user', name))) continue;
            stop(['systemctl', '--user', 'disable', '--now', name], () => false);
        }
        // The tray is not a service on Linux: it starts from the autostart file. Only our own python tray process.
        d.run(['pkill', '-u', String(process.getuid?.() ?? ''), '-f', 'python3 .*nucleon-sync-tray\\.py']);
        return failed;
    }
    const uid = process.getuid?.() ?? 0;
    for (const name of services.filter((s) => !s.endsWith('.service'))) {
        // launchctl bootout: 3 = no such process, 113 = could not find service.
        stop(['launchctl', 'bootout', `gui/${uid}/${name}`], (code) => code === 3 || code === 113);
    }
    return failed;
}

export async function runUninstall(d: UninstallDeps): Promise<void> {
    const { dataDir } = d;
    const appDir = path.join(d.home, '.local/share', APP_NAME, 'app');
    if (d.purgeData && d.syncedFolder && isInside(d.syncedFolder, dataDir)) {
        d.print(`Refusing --purge-data: your synced folder ${d.syncedFolder} is inside the data folder ${dataDir}, and it would be deleted. Nothing was changed.`);
        return;
    }
    if (d.purgeData && isInside(d.home, dataDir)) {
        d.print(`Refusing --purge-data: the data folder ${dataDir} holds your home folder, and it would be deleted. Nothing was changed.`);
        return;
    }
    const plan = planUninstall(d.home, !d.purgeData, dataDir);
    const services = plan.filter((e) => e.startsWith('service ')).map((e) => e.slice('service '.length));
    const paths = plan
        .filter((e) => !e.startsWith('service '))
        .filter((e) => exists(e) && (!e.includes('/.local/bin/') || isOurLink(e, appDir)));

    d.print('nucleon-sync uninstall will stop the service and remove:');
    for (const p of paths) d.print(`  ${p}`);
    if (d.purgeData) d.print('Your saved sign-in on this computer is removed too.');
    else d.print(`The data folder ${dataDir} (settings, history, quarantine) and your saved sign-in are kept.`);
    if (!(await d.ask('Remove these?'))) return d.print('Nothing was changed.');
    if (d.purgeData) {
        const second = `The data folder ${dataDir} also holds the quarantine, where files removed by a sync are kept. Delete it and your saved sign-in for good?`;
        if (!(await d.ask(second))) return d.print('Nothing was changed.');
    }

    const notStopped = stopServices(d, services);
    if (notStopped.length > 0) {
        d.print('The service could not be stopped, so nothing was removed. Run this by hand, then uninstall again:');
        for (const cmd of notStopped) d.print(`  ${cmd}`);
        if (d.platform === 'linux') {
            d.print(`If systemctl says it cannot reach the user bus, log in normally (not through su or sudo) and try again. On a system without user services, delete ${path.join(d.home, '.config/systemd/user/nucleon-sync.service')} by hand, then uninstall again.`);
        }
        return;
    }
    const notRemoved: string[] = [];
    for (const p of paths) {
        try {
            rmSync(p, { recursive: true, force: true });
        } catch (error) {
            notRemoved.push(`${p} (${(error as Error).message})`);
        }
    }
    if (d.platform === 'linux') d.run(['systemctl', '--user', 'daemon-reload']);
    if (d.purgeData) {
        try {
            await d.deleteSession();
        } catch (error) {
            notRemoved.push(`your saved sign-in, entry nucleon-sync/session in the password store (${(error as Error).message})`);
        }
    }
    if (notRemoved.length > 0) {
        d.print('nucleon-sync is only partly uninstalled. Could not remove:');
        for (const line of notRemoved) d.print(`  ${line}`);
    } else {
        d.print('nucleon-sync is uninstalled.');
    }
    if (d.syncedFolder) d.print(`Your synced folder was not touched: ${d.syncedFolder}`);
}
