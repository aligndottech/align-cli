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

  // BUG-2: the local client MUST return the same shape the cloud client does
  // ({results,count,strategy}) so `align ask` / `align search` (which read
  // results.results / results.count) work in local mode instead of throwing.
  it('searchDecisions returns the cloud {results,count,strategy} shape when empty', async () => {
    const result = await client.searchDecisions('TypeScript');
    expect(result).toMatchObject({ results: [], count: 0, strategy: 'semantic' });
  });

  it('searchDecisions returns stored decisions in cloud shape (results/count/similarity/status)', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Use TypeScript', 'cli');
    await client.captureDecision('Use Python', 'cli');
    const result = await client.searchDecisions('language choice', 5);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.count).toBe(result.results.length);
    expect(result.results[0]).toMatchObject({ status: 'active' });
    expect(typeof result.results[0].similarity).toBe('number');
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

  // BUG-3: the local client MUST return the same AlignmentResult status union the
  // cloud client uses (aligned|conflicting|no-context) + a `conflicts` array, so
  // `align check` (which branches on 'conflicting' + result.conflicts) reports a
  // real conflict in local mode instead of silently saying "no related decisions".
  it('checkAlignment returns "no-context" (cloud enum) when nothing is similar', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.0);
    const result = await client.checkAlignment('- use js\n+ use ts');
    expect(result.status).toBe('no-context');
    expect(result.relevant_decisions).toEqual([]);
  });

  it('checkAlignment returns "aligned" with a key hint when nothing is typed (no LLM key)', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    await client.ingestBatch([
      { source_url: 'https://jira/ABC-1', platform: 'jira', raw_text: 'Feature flag rollout', title: 'Rollout plan' },
    ]);
    const result = await client.checkAlignment('add a feature flag');
    expect(result.status).toBe('aligned');
    expect(result.relevant_decisions.length).toBeGreaterThan(0);
    expect(result.message).toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  });

  it('checkAlignment flags a typed conflict in the cloud AlignmentResult shape', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship).mockResolvedValue({ type: 'conflicts_with', confidence: 0.9, reason: 'opposes prior choice' });
    await client.ingestBatch([
      { source_url: 'https://slack.com/x', platform: 'slack', raw_text: 'We standardised on MySQL', title: 'Standardise on MySQL' },
    ]);
    const result = await client.checkAlignment('migrate the database to Postgres');
    expect(result.status).toBe('conflicting');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts![0].decision_id).toBeTruthy();
    expect(result.conflicts![0].severity).toBe('critical'); // confidence 0.9 >= 0.8
    expect(result.conflicts![0].reason).toBe('opposes prior choice');
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
    expect(found.results.length).toBe(2);
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
    await expect(client.getConflicts()).resolves.toHaveProperty('links');
  });
});