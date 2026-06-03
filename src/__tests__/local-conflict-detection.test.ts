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

describe('conflict detection threshold', () => {
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

  it('creates a conflicts_with link when similarity >= 0.65', async () => {
    mockCosine.mockReturnValue(0.82);
    await client.captureDecision('Use Postgres', 'cli');
    const result = await client.captureDecision('Use MySQL instead', 'cli');
    expect(result.conflicts).toHaveLength(1);
    const conflicts = await client.getConflicts();
    expect(conflicts.links).toHaveLength(1);
    expect(conflicts.links[0]!.relation).toBe('conflicts_with');
    expect(conflicts.links[0]!.confidence).toBeCloseTo(0.82);
  });

  it('does NOT create a conflict link when similarity < 0.65', async () => {
    mockCosine.mockReturnValue(0.30);
    await client.captureDecision('Use Postgres', 'cli');
    const result = await client.captureDecision('Deploy on Fridays is fine', 'cli');
    expect(result.conflicts).toHaveLength(0);
    const conflicts = await client.getConflicts();
    expect(conflicts.links).toHaveLength(0);
  });

  it('does NOT create a self-conflict link', async () => {
    mockCosine.mockReturnValue(1.0);
    await client.captureDecision('Use Postgres', 'cli');
    const conflicts = await client.getConflicts();
    expect(conflicts.links).toHaveLength(0);
  });

  it('creates conflict links for multiple matching decisions', async () => {
    // First two decisions are already captured, third conflicts with both
    mockCosine.mockReturnValue(0.0);
    await client.captureDecision('Use Postgres', 'cli');
    await client.captureDecision('Use MySQL', 'cli');
    mockCosine.mockReturnValue(0.75);
    const result = await client.captureDecision('Use SQLite instead', 'cli');
    expect(result.conflicts).toHaveLength(2);
  });
});
