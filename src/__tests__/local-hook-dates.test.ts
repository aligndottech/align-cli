import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ranking is driven by the mocked cosineSimilarity below; see helpers/mocked-cosine-matrix.ts.
vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  // Above every retrieval floor, so search and check both surface every row.
  cosineSimilarity: vi.fn().mockReturnValue(0.9),
  // EMBEDDING_MODEL_ID needed by ingestOne's setEmbedding call; a real
  // value (not a made-up test string) since findSimilar/checkDrift compare it against
  // the real constant too.
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['relates_to'],
}));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

/**
 * The edit hook shows each decision's date. The local client must hand it BOTH dates -
 * `decided_at` (the source's own timestamp) and `created_at` (the minute this CLI imported it) -
 * and the two must differ in the fixture, or a test cannot tell which one the hook used.
 */
const SHA = 'abc1234abc1234abc1234abc1234abc1234abc12';
const DECIDED = '2024-02-03T04:05:06Z';

beforeEach(() => { vi.stubEnv('ALIGN_DETECTOR', 'v0'); });
afterEach(() => { vi.unstubAllEnvs(); });

let dir: string;
let dbPath: string;
const opened: Array<{ close(): void }> = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali2100-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => {
  for (const h of opened.splice(0)) h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seeded() {
  const c = createLocalGatewayClient(dbPath);
  opened.push(c);
  const { snapshots } = await c.ingestBatch([
    { source_url: `https://github.com/acme/api/commit/${SHA}`, platform: 'git', raw_text: 'Use sqlite for the cache because it is embedded', title: 'Use sqlite for the cache', created_at: DECIDED },
  ]);
  return { c, id: snapshots[0]!.id };
}

describe('the local client carries both dates on a related decision', () => {
  it('checkAlignment at retrieval depth: decided_at is the source date, created_at the import time', async () => {
    const { c, id } = await seeded();
    const res = await c.checkAlignment('use sqlite for the cache', undefined, { depth: 'related' });
    const hit = res.relevant_decisions.find((r) => r.id === id);
    expect(hit?.decided_at).toBe('2024-02-03T04:05:06.000Z');
    expect(hit?.created_at).toBeDefined();
    expect(hit?.created_at?.slice(0, 4)).not.toBe('2024');
  });

  it('decisionsBySourceRefs (the blame lookup) carries both too', async () => {
    const { c, id } = await seeded();
    const [hit] = (c as unknown as { decisionsBySourceRefs(s: string[], p: string[]): Array<{ id: string; decided_at?: string; created_at?: string }> }).decisionsBySourceRefs([SHA], []);
    expect(hit?.id).toBe(id);
    expect(hit?.decided_at).toBe('2024-02-03T04:05:06.000Z');
    expect(hit?.created_at).toBeDefined();
  });

  it('a decision with no source date carries no decided_at, only created_at', async () => {
    const c = createLocalGatewayClient(dbPath);
    opened.push(c);
    const raw = createLocalDb(dbPath);
    opened.push(raw);
    const { snapshots } = await c.ingestBatch([{ source_url: 'claude-session://s1/m1', platform: 'agent-session', raw_text: 'Use sqlite for the cache', title: 'Use sqlite for the cache' }]);
    const res = await c.checkAlignment('use sqlite for the cache', undefined, { depth: 'related' });
    const hit = res.relevant_decisions.find((r) => r.id === snapshots[0]!.id);
    expect(hit).toBeDefined();
    expect(hit).not.toHaveProperty('decided_at');
    expect(hit?.created_at).toBeDefined();
  });
});
