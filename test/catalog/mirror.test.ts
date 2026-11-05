import { describe, expect } from 'bun:test';
import { DriveEventType } from '@protontech/drive-sdk';

import { row } from '../lib/catalog';
import { folder, node, ROOT_UID, setup } from '../lib/fake-sdk';

const area = 'Drive view';
const names = async (remote: { snapshot(): Promise<Map<string, { name: string }>> }) => [...(await remote.snapshot()).values()].map((e) => e.name).sort();

describe('the local view of the Drive', () => {
    row({ id: 'mirror.full-refresh', area, gesture: 'Proton asks for a full refresh', expected: 'The view is rebuilt from the Drive' }, async () => {
        const { drive, remote } = setup();
        drive.add(node('f', ROOT_UID, 'avant'));
        await remote.snapshot();
        drive.nodes.delete('f');
        drive.add(node('g', ROOT_UID, 'après'));
        drive.events.push({ type: DriveEventType.TreeRefresh, eventId: 'e1', treeEventScopeId: 's' });
        expect(await names(remote)).toEqual(['après']);
    });

    row({ id: 'mirror.refresh-cut', area, gesture: 'The connection drops during a full refresh', expected: 'The previous view stays whole: no file looks deleted' }, async () => {
        const { drive, remote } = setup();
        drive.add(node('f', ROOT_UID, 'photo'));
        await remote.snapshot();
        const walk = drive.iterateFolderChildren.bind(drive);
        drive.iterateFolderChildren = async function* () {
            throw new Error('connection lost');
            yield* walk('never');
        } as never;
        drive.events.push({ type: DriveEventType.TreeRefresh, eventId: 'e1', treeEventScopeId: 's' });
        await expect(remote.snapshot()).rejects.toThrow('connection lost');
        drive.iterateFolderChildren = walk as never;
        drive.events.length = 0;
        expect(await names(remote)).toEqual(['photo']);
    });

    row({ id: 'mirror.corrupted', area, gesture: 'The saved Drive view is corrupted', expected: 'The pass stops instead of guessing, nothing is touched' }, async () => {
        const { drive, kv, remote } = setup();
        drive.add(node('f', ROOT_UID, 'photo'));
        await remote.snapshot();
        for (const k of kv.keys()) kv.set(k, '{"eventId":"e1","entries":[{"id"');
        const fresh = setup();
        fresh.kv.set([...kv.keys()][0]!, kv.get([...kv.keys()][0]!)!);
        await expect(fresh.remote.snapshot()).rejects.toThrow();
    });

    row({ id: 'mirror.trashed-folder', area, gesture: 'A folder is trashed on the Drive', expected: 'It and its content leave the view' }, async () => {
        const { drive, remote } = setup();
        drive.add(folder('d', ROOT_UID, 'Album'));
        drive.add(node('f', 'd', 'photo'));
        await remote.snapshot();
        drive.events.push({ type: DriveEventType.NodeUpdated, nodeUid: 'd', eventId: 'e1', isTrashed: true });
        expect(await names(remote)).toEqual([]);
    });

    row({ id: 'mirror.volume-removed', area, gesture: 'Proton says the volume is gone', expected: 'The pass stops, nothing is deleted' }, async () => {
        const { drive, remote } = setup();
        drive.add(node('f', ROOT_UID, 'photo'));
        await remote.snapshot();
        drive.events.push({ type: DriveEventType.TreeRemove, eventId: 'e1', treeEventScopeId: 's' });
        await expect(remote.snapshot()).rejects.toThrow('removed');
    });
});
