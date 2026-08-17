import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockGetEmbedding, mockCosine } = vi.hoisted(() => ({
  mockGetEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  mockCosine: vi.fn().mockReturnValue(0.0),
}));

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: mockGetEmbedding,
  cosineSimilarity: mockCosine,
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

// ALI-503: this file used to assert that a cosine match writes `conflicts_with`, i.e. it
// pinned the defect as the specification. Same thresholds, same branches, correct label.
describe('similarity linking threshold (ALI-503)', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-conflict-test-${Date.now()}.db`);
    client = createLocalGatewayClient(dbPath);
    mockCosine.mockReturnValue(0.0);
  });

  afterEach(() => {
    client.close(); // release the SQLite handle so Windows can unlink the file (EBUSY otherwise)
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    vi.clearAllMocks();
  });

  it('creates a `relates` link when similarity >= 0.65, and reports NO conflict', async () => {
    mockCosine.mockReturnValue(0.82);
    await client.captureDecision('Use Postgres', 'cli');
    const result = await client.captureDecision('Use MySQL instead', 'cli');

    expect(result.related).toHaveLength(1);
    // Asserting the NEW relation, not merely the absence of the old one: getConflicts
    // filters on the literal string, so it fails silently empty and would pass either way.
    const links = await client.getImpact(result.id);
    const all = [...links.upstream, ...links.downstream];
    expect(all).toHaveLength(1);
    expect(all[0]!.relation).toBe('relates');
    expect(all[0]!.confidence).toBeCloseTo(0.82);
    expect((await client.getConflicts()).conflict_count).toBe(0);
  });

  it('does NOT link at all when similarity < 0.65', async () => {
    mockCosine.mockReturnValue(0.30);
    await client.captureDecision('Use Postgres', 'cli');
    const result = await client.captureDecision('Deploy on Fridays is fine', 'cli');

    expect(result.related).toHaveLength(0);
    const links = await client.getImpact(result.id);
    expect([...links.upstream, ...links.downstream]).toHaveLength(0);
  });

  it('does NOT link a decision to itself', async () => {
    mockCosine.mockReturnValue(1.0);
    const only = await client.captureDecision('Use Postgres', 'cli');

    const links = await client.getImpact(only.id);
    expect([...links.upstream, ...links.downstream]).toHaveLength(0);
  });

  it('links to every matching decision, not just the first', async () => {
    // Two decisions already captured; the third is similar to both.
    mockCosine.mockReturnValue(0.0);
    await client.captureDecision('Use Postgres', 'cli');
    await client.captureDecision('Use MySQL', 'cli');
    mockCosine.mockReturnValue(0.75);
    const result = await client.captureDecision('Use SQLite instead', 'cli');

    expect(result.related).toHaveLength(2);
    expect((await client.getConflicts()).conflict_count).toBe(0);
  });
});
