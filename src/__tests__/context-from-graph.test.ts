/**
 * The session-start hook's fallback: with no `.align/decisions.md` in the repo, a LOCAL graph is
 * read directly so the agent still starts the session with the decisions in front of it. Before
 * this, a normal setup never wrote that file, so the hook printed nothing and the agent only met
 * the graph if it chose to call a tool.
 *
 * Test List:
 * 1. a local graph with decisions: the text names each active decision (two titles, so one is not a constant)
 * 2. a superseded decision is left out, as `align context sync` leaves it out
 * 3. an empty graph: null, so the hook prints nothing rather than "no decisions"
 * 4. no graph file at the path: null, and no file is created there
 * 5. a hosted environment (not local-embedded): null, never a network call
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  // Below every linking floor, so seeding two decisions writes no link between them.
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['relates_to'],
}));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { decisionsFromLocalGraph } from '../lib/context-from-graph.js';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

let dir: string;
let dbPath: string;
const local = (p: string) => ({ mode: 'local-embedded' as const, localDbPath: p });

beforeEach(() => {
  vi.stubEnv('ALIGN_DETECTOR', 'v0');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-from-graph-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seed(titles: string[]): Promise<string[]> {
  const c = createLocalGatewayClient(dbPath, { cwd: dir });
  try {
    const { snapshots } = await c.ingestBatch(titles.map((t, i) => ({
      source_url: `https://github.com/acme/api/pull/${i + 1}`, platform: 'github', raw_text: t, title: t,
    })));
    return snapshots.map((s) => s.id);
  } finally {
    c.close();
  }
}

describe('decisionsFromLocalGraph', () => {
  it('names every active decision in the local graph', async () => {
    await seed(['Use Postgres 16 for the events store', 'Retry webhooks three times with backoff']);
    const text = await decisionsFromLocalGraph(dir, { env: () => local(dbPath) });
    expect(text).toContain('Use Postgres 16 for the events store');
    expect(text).toContain('Retry webhooks three times with backoff');
  });

  it('says where the list came from, and does not call itself a file to edit', async () => {
    await seed(['Use Postgres 16 for the events store']);
    const text = await decisionsFromLocalGraph(dir, { env: () => local(dbPath) });
    expect(text).toContain('Use Postgres 16 for the events store'); // positive control
    expect(text).toContain('Read from your local Align graph');
    expect(text).not.toContain('Edits here are overwritten');
  });

  it('leaves out a decision that was superseded', async () => {
    const [older, newer] = await seed(['Cache sessions in Redis', 'Cache sessions in Postgres']);
    const db = createLocalDb(dbPath);
    try {
      db.insertLink({ sourceId: newer!, targetId: older!, relation: 'supersedes', confidence: 1 });
    } finally {
      db.close();
    }
    const text = await decisionsFromLocalGraph(dir, { env: () => local(dbPath) });
    expect(text).toContain('Cache sessions in Postgres'); // positive control: the read worked
    expect(text).not.toContain('Cache sessions in Redis');
  });

  it('returns null for a graph with no decisions, so the hook prints nothing', async () => {
    const c = createLocalGatewayClient(dbPath, { cwd: dir });
    c.close();
    expect(fs.existsSync(dbPath)).toBe(true); // the graph exists, it is just empty
    expect(await decisionsFromLocalGraph(dir, { env: () => local(dbPath) })).toBeNull();
  });

  it('returns null when there is no graph at the path, and creates none', async () => {
    const missing = path.join(dir, 'nope.db');
    expect(await decisionsFromLocalGraph(dir, { env: () => local(missing) })).toBeNull();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('returns null for a hosted environment', async () => {
    await seed(['Use Postgres 16 for the events store']);
    expect(await decisionsFromLocalGraph(dir, { env: () => ({ mode: 'cloud', localDbPath: dbPath }) })).toBeNull();
  });
});
