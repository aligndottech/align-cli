import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
}));

vi.mock('../lib/local-relationship-classifier.js', () => ({
  // Default: no LLM key -> degrade to untyped (returns null)
  classifyRelationship: vi.fn().mockResolvedValue(null),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'refines', 'implements', 'depends_on', 'relates_to'],
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { cosineSimilarity } from '../lib/local-embeddings.js';
import { classifyRelationship } from '../lib/local-relationship-classifier.js';

describe('local-gateway-client', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-lgc-test-${Date.now()}.db`);
    client = createLocalGatewayClient(dbPath);
    vi.mocked(cosineSimilarity).mockReturnValue(0.0);
    vi.mocked(classifyRelationship).mockResolvedValue(null);
  });

  afterEach(() => {
    client.close(); // release the SQLite handle so Windows can unlink the file (EBUSY otherwise)
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('whoami returns local identity', async () => {
    const result = await client.whoami();
    expect(result).toHaveProperty('email', 'local');
  });

  it('captureDecision stores a decision and returns snapshot with id', async () => {
    const result = await client.captureDecision('We decided to use TypeScript', 'cli');
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('conflicts');
    expect(Array.isArray(result.conflicts)).toBe(true);
  });

  it('searchDecisions returns empty array when no decisions exist', async () => {
    const result = await client.searchDecisions('TypeScript');
    expect(result).toHaveProperty('decisions');
    expect(result.decisions).toEqual([]);
  });

  it('searchDecisions returns stored decisions ranked above threshold', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Use TypeScript', 'cli');
    await client.captureDecision('Use Python', 'cli');
    const result = await client.searchDecisions('language choice', 5);
    expect(result.decisions.length).toBeGreaterThan(0);
  });

  it('getConflicts returns empty when no conflicts', async () => {
    const result = await client.getConflicts();
    expect(result).toHaveProperty('links');
    expect(result.links).toEqual([]);
  });

  it('getImpact returns upstream and downstream arrays for a decision id', async () => {
    const captured = await client.captureDecision('Use TypeScript', 'cli');
    const result = await client.getImpact(captured.id);
    expect(result).toHaveProperty('upstream');
    expect(result).toHaveProperty('downstream');
    expect(Array.isArray(result.upstream)).toBe(true);
    expect(Array.isArray(result.downstream)).toBe(true);
  });

  it('checkAlignment returns no_context when nothing is similar', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.0);
    const result = await client.checkAlignment('- use js\n+ use ts');
    expect(result.status).toBe('no_context');
    expect(result.relevant_decisions).toEqual([]);
  });

  it('checkAlignment returns untyped "related" when no LLM key (classifier returns null)', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    await client.ingestBatch([
      { source_url: 'https://jira/ABC-1', platform: 'jira', raw_text: 'Feature flag rollout', title: 'Rollout plan' },
    ]);
    const result = await client.checkAlignment('add a feature flag');
    expect(result.status).toBe('related');
    expect(result.relevant_decisions[0].relationship).toBe('relates_to');
    expect(result.relevant_decisions[0].typed).toBe(false);
    expect(result.relevant_decisions[0].platform).toBe('jira'); // cross-tool visible
  });

  it('checkAlignment flags a typed cross-tool conflict when the classifier types it', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship).mockResolvedValue({ type: 'conflicts_with', confidence: 0.9, reason: 'opposes prior choice' });
    await client.ingestBatch([
      { source_url: 'https://slack.com/x', platform: 'slack', raw_text: 'We standardised on MySQL', title: 'Standardise on MySQL' },
    ]);
    const result = await client.checkAlignment('migrate the database to Postgres');
    expect(result.status).toBe('conflict');
    expect(result.conflicting_decisions).toHaveLength(1);
    expect(result.conflicting_decisions[0].platform).toBe('slack');
    expect(result.conflicting_decisions[0].relationship).toBe('conflicts_with');
  });

  it('checkDrift returns score for a known decision', async () => {
    const captured = await client.captureDecision('Use TypeScript', 'cli');
    const result = await client.checkDrift(captured.id, 'some content to compare', 'code');
    expect(result).toHaveProperty('score');
  });

  it('ingestBatch persists each item and returns cloud-compatible snapshots', async () => {
    const result = await client.ingestBatch([
      { source_url: 'git://commit/a', platform: 'git', raw_text: 'Adopt Postgres', title: 'Adopt Postgres' },
      { source_url: 'git://commit/b', platform: 'git', raw_text: 'Adopt Redis', title: 'Adopt Redis' },
    ]);
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots[0]).toHaveProperty('id');
    expect(result.snapshots[0].title).toBe('Adopt Postgres');
    expect(result.snapshots[0].analysis).toHaveProperty('relatedDecisions');
    // Persisted: a search (with similarity above threshold) finds them back
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    const found = await client.searchDecisions('database', 10);
    expect(found.decisions.length).toBe(2);
  });

  it('ingestBatch records a conflicts_with relationship when items are similar', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.9); // above CONFLICT_THRESHOLD
    const result = await client.ingestBatch([
      { source_url: 'git://commit/a', platform: 'git', raw_text: 'Use MySQL', title: 'Use MySQL' },
      { source_url: 'git://commit/b', platform: 'git', raw_text: 'Use Postgres', title: 'Use Postgres' },
    ]);
    // second item conflicts with the first
    const related = result.snapshots[1].analysis?.relatedDecisions ?? [];
    expect(related.length).toBeGreaterThan(0);
    expect(related[0].relationship).toBe('conflicts_with');
    expect(client.getConflicts()).resolves.toHaveProperty('links');
  });
});
