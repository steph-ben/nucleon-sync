export interface SetupAnswers {
    folder: string;
    target: 'test' | 'myfiles';
    /** The user typed the confirmation for their real data. */
    confirmed: boolean;
    deviceName: string;
}

export function buildConfig(a: SetupAnswers) {
    if (a.target === 'myfiles' && !a.confirmed) throw new Error('My files needs an explicit confirmation');
    const common = { localRoot: a.folder, deviceName: a.deviceName, maxDeletes: 20 };
    return a.target === 'myfiles' ? { ...common, remote: 'root', allowDriveRoot: true } : { ...common, remote: `device:proton-sync-test/sandbox-${a.deviceName}` };
}
