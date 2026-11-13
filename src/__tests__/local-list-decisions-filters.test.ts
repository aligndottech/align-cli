/**
 * listDecisions must filter on platform and status BEFORE it slices to the limit.
 * 1. 5 git rows then 3 docs rows, platform 'docs', limit 2 -> 2 docs rows (matches sit past the limit)
 * 2. platform 'git' returns only git rows
 * 3. status other than 'active' is an equality filter on the row's status
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn(() => 0),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

describe('local listDecisions platform and status filters', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;
  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `align-list-${Date.now()}-${Math.random()}.db`);
    client = createLocalGatewayClient(dbPath);
    const mk = (platform: string, n: number) => ({ title: `${platform} item ${n}`, raw_text: `${platform} item ${n} distinct text ${Math.random()}`, platform, created_at: `2026-10-0${n}T10:00:00Z`, source_url: `https://example.com/${platform}/${n}` });
    // newest first is the db's order, so docs rows (created last) sit beyond a small limit
    await client.ingestBatch([...[1, 2, 3, 4, 5].map(n => mk('git', n)), ...[6, 7, 8].map(n => mk('docs', n))], { classify: false });
  });
  afterEach(() => { client.close(); if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); });

  it('applies the platform filter before the limit', async () => {
    const rows = await client.listDecisions({ platform: 'docs', limit: 2, all: true });
    expect(rows.map(r => r.platform)).toEqual(['docs', 'docs']);
  });
  it('returns only git rows for platform git', async () => {
    const rows = await client.listDecisions({ platform: 'git', all: true });
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map(r => r.platform))).toEqual(new Set(['git']));
  });
  it('treats a status other than active as equality', async () => {
    expect(await client.listDecisions({ status: 'superseded', all: true })).toEqual([]);
    expect((await client.listDecisions({ status: 'active', all: true })).length).toBe(8);
  });
});
