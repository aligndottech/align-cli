import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmDir } from './helpers/rm-dir.js';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(),
  cosineSimilarity: vi.fn(),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'refines', 'implements', 'depends_on', 'relates_to'],
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { cosineSimilarity, getEmbedding } from '../lib/local-embeddings.js';

/**
 * Golden for ranking on every platform that is NOT git. Lexical fusion applies to git commits
 * only, so a graph without commits must rank exactly as it did before it existed. The expected orders below
 * were produced by the code on origin/main at 0ec9551 (before the lexical list), and this file is the
 * pin: if it goes red, a non-git ranking moved.
 */
beforeEach(() => { vi.stubEnv('ALIGN_DETECTOR', 'v0'); });
afterEach(() => { vi.unstubAllEnvs(); });

const ROWS: Array<{ tag: string; platform: string; title: string; dense: number }> = [
  { tag: 'a', platform: 'slack', title: 'we agreed to drop the legacy auth proxy', dense: 0.71 },
  { tag: 'b', platform: 'slack', title: 'auth proxy latency is fine for now', dense: 0.69 },
  { tag: 'c', platform: 'jira', title: 'replace zorblax-match with the new router', dense: 0.41 },
  { tag: 'd', platform: 'jira', title: 'router notes and routing examples', dense: 0.66 },
  { tag: 'e', platform: 'cli', title: 'use pino for logging everywhere', dense: 0.52 },
  { tag: 'f', platform: 'cli', title: 'logging format is json lines', dense: 0.5 },
  { tag: 'g', platform: 'slack', title: 'node18 is the floor for the worker', dense: 0.3 },
  { tag: 'h', platform: 'jira', title: 'processes crash on retry', dense: 0.28 },
  { tag: 'i', platform: 'cli', title: 'quuxmatic appendix', dense: 0.1 },
  { tag: 'j', platform: 'slack', title: 'unrelated chatter about lunch', dense: 0.26 },
];
const QUERIES = ['why did we drop the legacy auth proxy', 'why zorblax-match', 'why do we use pino', 'why node 18', 'why do processes crash', 'why quuxmatic'];
const GOLDEN: Record<string, string[]> = {
  'why did we drop the legacy auth proxy': ['a', 'b', 'd', 'e', 'f', 'c'],
  'why zorblax-match': ['a', 'b', 'd', 'e', 'f', 'c'],
  'why do we use pino': ['e', 'a', 'b', 'd', 'f', 'c'],
  'why node 18': ['a', 'b', 'd', 'e', 'f', 'c'],
  'why do processes crash': ['a', 'b', 'd', 'e', 'f', 'c'],
  'why quuxmatic': ['a', 'b', 'd', 'e', 'f', 'c'],
};

describe('non-git ranking is unchanged by the lexical list', () => {
  let dir: string;
  let client: ReturnType<typeof createLocalGatewayClient>;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'align-golden-'));
    client = createLocalGatewayClient(path.join(dir, 'g.db'));
    const byTag = Object.fromEntries(ROWS.map((r, i) => [i + 1, r.dense]));
    vi.mocked(getEmbedding).mockImplementation(async (t: string) => {
      const v = new Float32Array(384).fill(0.1);
      v[0] = ROWS.findIndex(r => t.includes(r.title)) + 1;
      return v;
    });
    vi.mocked(cosineSimilarity).mockImplementation((_q: Float32Array, stored: Float32Array) => byTag[stored[0]!] ?? 0);
    for (const r of ROWS) await client.captureDecision(`${r.title}`, r.platform);
  });
  afterEach(() => { client.close(); rmDir(dir); });

  it.each(QUERIES)('%s', async q => {
    const { results } = await client.searchDecisions(q, 6, undefined, { all: true });
    const got = results.map(r => ROWS.find(x => x.title === r.title)!.tag);
    expect(got).toEqual(GOLDEN[q]);
  });
});
