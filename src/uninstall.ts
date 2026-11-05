import { existsSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
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
        return readlinkSync(link).startsWith(appDir);
    } catch {
        return false;
    }
}

function stopServices(d: UninstallDeps, services: string[]) {
    if (d.platform === 'linux') {
        for (const name of services.filter((s) => s.endsWith('.service'))) d.run(['systemctl', '--user', 'disable', '--now', name]);
        return;
    }
    const uid = process.getuid?.() ?? 0;
    for (const name of services.filter((s) => !s.endsWith('.service'))) d.run(['launchctl', 'bootout', `gui/${uid}/${name}`]);
}

export async function runUninstall(d: UninstallDeps): Promise<void> {
    const appDir = path.join(d.home, '.local/share', APP_NAME, 'app');
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

    stopServices(d, services);
    for (const p of paths) rmSync(p, { recursive: true, force: true });
    if (d.platform === 'linux') d.run(['systemctl', '--user', 'daemon-reload']);
    d.print('nucleon-sync is uninstalled.');
    if (d.syncedFolder) d.print(`Your synced folder was not touched: ${d.syncedFolder}`);
}
