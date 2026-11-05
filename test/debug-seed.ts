// Replays a fuzz seed and prints the state and plan of the failing pass.
import { replay } from './fuzz-lib';
const [seed, crash, mid] = [Number(process.argv[2]), Number(process.argv[3] ?? 0), process.argv[4] === 'mid'];
await replay(seed, crash, mid);
