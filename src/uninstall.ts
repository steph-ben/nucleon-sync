import { lstatSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { APP_NAME } from './names';

const SERVICES = ['nucleon-sync.service', 'org.nucleonsync.daemon', 'org.nucleonsync.tray'];

/** What uninstall removes: file paths, and "service <name>" entries. Never the synced folder; the data folder only if purging. */
export function planUninstall(home: string, keepData: boolean): string[] {
    const data = path.join(home, '.local/share', APP_NAME);
    const plan = [
        ...SERVICES.map((name) => `service ${name}`),
        path.join(home, '.config/systemd/user/nucleon-sync.service'),
        path.join(home, 'Library/LaunchAgents/org.nucleonsync.daemon.plist'),
        path.join(home, 'Library/LaunchAgents/org.nucleonsync.tray.plist'),
        path.join(home, '.config/autostart/nucleon-sync-tray.desktop'),
        path.join(home, '.local/bin/nucleon-sync'),
        path.join(home, '.local/bin/nucleon-sync-tray'),
        path.join(data, 'app'),
    ];
    return keepData ? plan : [...plan, data];
}

export type UninstallDeps = {
    home: string;
    platform: 'linux' | 'darwin';
    purgeData: boolean;
    /** Path of the synced folder, printed at the end and never touched. */
    syncedFolder: string | undefined;
    ask: (question: string) => Promise<boolean>;
    print: (line: string) => void;
    run: (cmd: string[]) => number;
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
            // "Unit file does not exist" (exit 1 on disable) means there is nothing to stop.
            const known = d.run(['systemctl', '--user', 'cat', name]) === 0;
            if (known) stop(['systemctl', '--user', 'disable', '--now', name], () => false);
        }
        // The tray is not a service on Linux: it starts from the autostart file.
        d.run(['pkill', '-f', 'nucleon-sync-tray.py']);
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
    const dataDir = path.join(d.home, '.local/share', APP_NAME);
    const appDir = path.join(dataDir, 'app');
    if (d.purgeData && d.syncedFolder && isInside(d.syncedFolder, dataDir)) {
        d.print(`Refusing --purge-data: your synced folder ${d.syncedFolder} is inside the data folder ${dataDir}, and it would be deleted. Nothing was changed.`);
        return;
    }
    const plan = planUninstall(d.home, !d.purgeData);
    const services = plan.filter((e) => e.startsWith('service ')).map((e) => e.slice('service '.length));
    const paths = plan
        .filter((e) => !e.startsWith('service '))
        .filter((e) => exists(e) && (!e.includes('/.local/bin/') || isOurLink(e, appDir)));

    d.print('nucleon-sync uninstall will stop the service and remove:');
    for (const p of paths) d.print(`  ${p}`);
    if (!d.purgeData) d.print('The data folder (settings, sign-in, history, quarantine) is kept.');
    if (!(await d.ask('Remove these?'))) return d.print('Nothing was changed.');
    if (d.purgeData) {
        const second = 'The data folder also holds the quarantine, where files removed by a sync are kept. Delete it for good?';
        if (!(await d.ask(second))) return d.print('Nothing was changed.');
    }

    const notStopped = stopServices(d, services);
    if (notStopped.length > 0) {
        d.print('The service could not be stopped, so nothing was removed. Run this by hand, then uninstall again:');
        for (const cmd of notStopped) d.print(`  ${cmd}`);
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
    if (notRemoved.length > 0) {
        d.print('nucleon-sync is only partly uninstalled. Could not remove:');
        for (const line of notRemoved) d.print(`  ${line}`);
    } else {
        d.print('nucleon-sync is uninstalled.');
    }
    if (d.syncedFolder) d.print(`Your synced folder was not touched: ${d.syncedFolder}`);
}
