/**
 * Load a frozen JSON snapshot into a throwaway local graph (shared detector plan, Phase B).
 *
 *   npx tsx scripts/load-local-snapshot.ts <snapshot.json> --db <new path> [--links]
 *
 * --db must name a file that does not exist yet, and never the real local.db. The snapshot shape
 * is `Snapshot` in src/lib/local-snapshot-loader.ts. No network, no model call.
 */
import { readFileSync } from 'node:fs';
import { loadSnapshot, type Snapshot } from '../src/lib/local-snapshot-loader.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dbIndex = args.indexOf('--db');
const db = dbIndex >= 0 ? args[dbIndex + 1] : undefined;
if (!file || !db) {
  console.error('usage: npx tsx scripts/load-local-snapshot.ts <snapshot.json> --db <new path> [--links]');
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
const r = loadSnapshot(snapshot, db, { links: args.includes('--links') });
console.log(`Loaded ${r.decisions} decisions and ${r.links} links from ${snapshot.snapshot} into ${db}.`);
