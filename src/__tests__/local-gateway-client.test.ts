import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
}));

vi.mock('../lib/local-relationship-classifier.js', () => ({
  // Default: no LLM key -> the classifier cannot run and says so (ALI-414)
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
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
    vi.mocked(classifyRelationship).mockResolvedValue({ ok: false, reason: 'no_llm_key' });
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
    // ALI-503: was `conflicts`. It holds cosine-similar decision ids and no judgement,
    // and align_capture returns this object straight to an agent.
    expect(result).toHaveProperty('related');
    expect(Array.isArray(result.related)).toBe(true);
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

  it('orders equal-similarity results by a stable id tiebreaker (deterministic)', async () => {
    // ALI-218: when several decisions share an identical similarity score, the
    // slice of top-K candidates must be stable across runs - otherwise the same
    // offline scan compares a different candidate set each time. Force a tie and
    // assert the results come back sorted by id, not in arbitrary insert order.
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Alpha decision', 'cli');
    await client.captureDecision('Bravo decision', 'cli');
    await client.captureDecision('Charlie decision', 'cli');

    const result = await client.searchDecisions('anything', 10);
    const ids = result.results.map((r: { id: string }) => r.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
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

  // ALI-414: this test previously asserted `aligned` here, pinning the fail-open. A
  // retrieved decision that was never classified is exactly the state where the CLI
  // does NOT know, and an agent branching on `status` reads `aligned` as permission
  // to proceed past a contradicting decision. Unset key = default state of a fresh
  // `npm i @aligndottech/cli`, so this is the normal first-run path.
  it('checkAlignment returns "unknown" (never "aligned") when no LLM key can type the candidates', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    await client.ingestBatch([
      { source_url: 'https://jira/ABC-1', platform: 'jira', raw_text: 'Feature flag rollout', title: 'Rollout plan' },
    ]);
    const result = await client.checkAlignment('add a feature flag');
    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('no_llm_key');
    // The retrieved decisions and the key hint both survive - the human still sees
    // what could not be checked, and how to make it checkable.
    expect(result.relevant_decisions.length).toBeGreaterThan(0);
    expect(result.message).toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  });

  // ALI-420: same "unknown" status, different remedy. The no_llm_key hint above tells the
  // user to run a local Ollama; this user already is, and the model is what disqualified
  // them. Telling them to do the thing they have done is worse than saying nothing.
  it('checkAlignment names the model remedy when the local model was unvetted', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship).mockResolvedValue({ ok: false, reason: 'unvetted_local_model' });
    await client.ingestBatch([
      { source_url: 'https://jira/ABC-2', platform: 'jira', raw_text: 'Feature flag rollout', title: 'Rollout plan' },
    ]);

    const result = await client.checkAlignment('add a feature flag');

    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('unvetted_local_model');
    expect(result.message).toMatch(/ollama pull|ALIGN_OLLAMA_MODEL/);
    expect(result.message).not.toMatch(/run a local Ollama/);
  });

  // The pair for the test above: proves the happy path was not simply renamed. A
  // classifier that RAN and returned a confident non-conflict is a real `aligned`.
  it('checkAlignment returns "aligned" when every candidate is classified as a non-conflict', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship).mockResolvedValue({
      ok: true,
      relationship: { type: 'relates', confidence: 0.7, reason: 'same area, no opposition' },
    });
    await client.ingestBatch([
      { source_url: 'https://jira/ABC-1', platform: 'jira', raw_text: 'Feature flag rollout', title: 'Rollout plan' },
    ]);
    const result = await client.checkAlignment('add a feature flag');
    expect(result.status).toBe('aligned');
    expect(result.reason).toBeUndefined();
    expect(result.relevant_decisions.length).toBeGreaterThan(0);
  });

  it('checkAlignment returns "unknown" with reason classifier_error when a configured provider fails', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship).mockResolvedValue({ ok: false, reason: 'classifier_error' });
    await client.ingestBatch([
      { source_url: 'https://jira/ABC-1', platform: 'jira', raw_text: 'Feature flag rollout', title: 'Rollout plan' },
    ]);
    const result = await client.checkAlignment('add a feature flag');
    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('classifier_error');
  });

  it('checkAlignment returns "unknown" for unparseable classifier output - never a default', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship).mockResolvedValue({ ok: false, reason: 'classifier_unparseable' });
    await client.ingestBatch([
      { source_url: 'https://jira/ABC-1', platform: 'jira', raw_text: 'Feature flag rollout', title: 'Rollout plan' },
    ]);
    const result = await client.checkAlignment('add a feature flag');
    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('classifier_unparseable');
  });

  it('checkAlignment flags a typed conflict in the cloud AlignmentResult shape', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship).mockResolvedValue({
      ok: true,
      relationship: { type: 'conflicts_with', confidence: 0.9, reason: 'opposes prior choice' },
    });
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

  // Second example for the aggregation rule: a found conflict is still worth
  // surfacing even when a sibling candidate could not be typed. `conflicting` is
  // strictly more actionable than `unknown`, so it wins.
  it('checkAlignment reports "conflicting" when one candidate conflicts and another is unclassified', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship)
      .mockResolvedValueOnce({ ok: false, reason: 'classifier_error' })
      .mockResolvedValueOnce({ ok: true, relationship: { type: 'conflicts_with', confidence: 0.9 } });
    await client.ingestBatch([
      { source_url: 'https://slack.com/a', platform: 'slack', raw_text: 'Standardise on MySQL', title: 'Standardise on MySQL' },
      { source_url: 'https://slack.com/b', platform: 'slack', raw_text: 'Cache with Redis', title: 'Cache with Redis' },
    ]);
    const result = await client.checkAlignment('migrate the database to Postgres');
    expect(result.status).toBe('conflicting');
    expect(result.conflicts).toHaveLength(1);
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

  it('ingestBatch records a `relates` relationship when items are similar', async () => {
    // ALI-503: this asserted `conflicts_with`. Similar wording is not opposition, and the
    // returned analysis must match the relation actually written to the row.
    vi.mocked(cosineSimilarity).mockReturnValue(0.9); // above SIMILARITY_THRESHOLD
    const result = await client.ingestBatch([
      { source_url: 'git://commit/a', platform: 'git', raw_text: 'Use MySQL', title: 'Use MySQL' },
      { source_url: 'git://commit/b', platform: 'git', raw_text: 'Use Postgres', title: 'Use Postgres' },
    ]);

    const related = result.snapshots[1].analysis?.relatedDecisions ?? [];
    expect(related.length).toBeGreaterThan(0);
    expect(related[0].relationship).toBe('relates');
    expect((await client.getConflicts()).conflict_count).toBe(0);
  });
});