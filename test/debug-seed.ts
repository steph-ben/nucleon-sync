// Rejoue une graine de fuzz et affiche l'état et le plan de la passe qui échoue.
import { replay } from './fuzz-lib';
const [seed, crash, mid] = [Number(process.argv[2]), Number(process.argv[3] ?? 0), process.argv[4] === 'mid'];
await replay(seed, crash, mid);
