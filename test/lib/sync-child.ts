/** A real process running one sync pass, slowly enough to be killed half-way. Usage: home hubFile */
import { loadHub, saveHub } from './hub-file';
import { machine } from './world';

const [home, hubFile] = process.argv.slice(2) as [string, string];
const hub = loadHub(hubFile);
const m = machine('A', hub, { home });
const drive = m.drive as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
for (const op of ['mkdir', 'move', 'upload', 'uploadRevision', 'download', 'trash']) {
    const real = drive[op]!.bind(m.drive);
    drive[op] = async (...args: unknown[]) => {
        await Bun.sleep(5);
        const result = await real(...args);
        saveHub(hub, hubFile); // the Drive has it before the base does, as in real life
        return result;
    };
}
await m.engine.cycle();
