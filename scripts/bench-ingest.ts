/**
 * Local ingest cost per item as the stored graph grows (plan phase LB, journey 4).
 *
 *   npx tsx scripts/bench-ingest.ts [maxItems=5000] [--classify-off is always on]
 *
 * Runs the real embedding model (cached after the first run) against an in-memory graph with
 * the classifier off, ingesting synthetic connector-shaped items in batches of 250. Prints, per
 * batch boundary: the cumulative average ms/item (what P0 reported) and the MARGINAL ms/item of
 * the last batch (the cost of one more item at that graph size, which is what the target in the
 * plan bounds). Zero LLM spend: no provider key is read.
 */
import { createLocalGatewayClient } from '../src/lib/local-gateway-client.js';

const BATCH = 250;
const max = Number(process.argv[2] ?? 5000);

// Seeded so every run (and the before/after comparison) ingests identical text.
let seed = 0x9e3779b9;
const rand = () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0; return seed / 2 ** 32; };
const TOPICS = ['payments retries', 'auth tokens', 'deploy pipeline', 'search ranking', 'database migrations',
  'rate limits', 'onboarding flow', 'billing invoices', 'cache invalidation', 'mobile release', 'incident review', 'api versioning'];
const VERBS = ['decided to', 'agreed that we should', 'will not', 'switched to', 'dropped', 'standardised on', 'postponed'];
const OBJS = ['the queue worker', 'a shared client', 'weekly batches', 'feature flags', 'the legacy endpoint', 'strict timeouts',
  'a read replica', 'idempotency keys', 'the new schema', 'manual approval', 'structured logs', 'a staging gate'];
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)]!;
const item = (i: number) => ({
  platform: i % 3 === 0 ? 'github' : i % 3 === 1 ? 'slack' : 'linear',
  source_url: `https://example.test/item/${i}`,
  title: `${pick(TOPICS)} ${i}`,
  raw_text: `Regarding ${pick(TOPICS)}: we ${pick(VERBS)} ${pick(OBJS)}, because ${pick(TOPICS)} needs ${pick(OBJS)}. ` +
    `Follow-up ${i}: ${pick(VERBS)} ${pick(OBJS)} after review.`,
});

const client = createLocalGatewayClient(':memory:');
let total = 0;
console.log('stored  cumulative ms/item  marginal ms/item (last batch)');
for (let done = 0; done < max; done += BATCH) {
  const items = Array.from({ length: BATCH }, (_, k) => item(done + k));
  const t0 = performance.now();
  await client.ingestBatch(items, { classify: false, keyed: true });
  const ms = performance.now() - t0;
  total += ms;
  const n = done + BATCH;
  if (n === 250 || n === 2000 || n === 5000 || n % 1000 === 0 || n >= max) {
    console.log(`${String(n).padStart(6)}  ${(total / n).toFixed(2).padStart(15)}  ${(ms / BATCH).toFixed(2).padStart(16)}`);
  }
}
client.close();
