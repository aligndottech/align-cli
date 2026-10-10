/** A process that tries to take the launch claim at an agreed instant and prints 1 (won) or 0. Run by bg-claim.test.ts. */
import { takeClaim } from '../../lib/sync/bg-claim.js';

const [dir, source, now, interval, barrier] = process.argv.slice(2) as [string, string, string, string, string];
while (Date.now() < Number(barrier)) { /* spin until everyone is ready */ }
process.stdout.write(takeClaim(dir, source, Number(now), Number(interval)).ok ? '1' : '0');
