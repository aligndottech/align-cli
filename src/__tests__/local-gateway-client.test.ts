import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
  // ALI-787: real value, not a test-only string - the tests below assert the model tag a
  // stale-model row must NOT match, and a made-up constant here would let that assertion
  // pass for a reason unrelated to the code (mock value == mock value) rather than because
  // ingestOne actually threads the real EMBEDDING_MODEL_ID through.
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

vi.mock('../lib/local-relationship-classifier.js', () => ({
  // Default: no LLM key -> the classifier cannot run and says so (ALI-414)
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'refines', 'implements', 'depends_on', 'relates_to'],
}));

// No local-llm mock any more: this branch removes the module-level `getLlmFailure()` that had to
// be faked here, because the failure now travels back on the classifier's own return value. That
// is the whole point of the refactor - a module variable could be cleared by a concurrent call -
// and it means one less piece of shared state for this suite to arrange.
// RECOMMENDED_OLLAMA_PULL is still imported for real below, so a test asserting the pull hint
// compares against the constant the command actually renders rather than a copy of it.
import {
  createLocalGatewayClient,
  RELATES_THRESHOLD,
  RETRIEVAL_RELATES_THRESHOLD,
} from '../lib/local-gateway-client.js';
import { cosineSimilarity, EMBEDDING_MODEL_ID } from '../lib/local-embeddings.js';
import { classifyRelationship } from '../lib/local-relationship-classifier.js';
import { RECOMMENDED_OLLAMA_PULL } from '../lib/local-llm.js';
import { createLocalDb } from '../lib/local-db.js';

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

  // The advisory hook asks for retrieval only (`depth:'related'`, check.ts) because
  // adjudication fits no host's hook budget - and because in local mode Stage 2 is also an
  // EGRESS: each classification sends the proposed content plus a stored decision to the
  // user's own LLM provider. The cloud client forwards the option (gateway #1415, status
  // 'retrieved'); the local client's two-arg signature silently discarded it and adjudicated
  // anyway, up to 5 provider calls per agent Write/Edit.
  it('checkAlignment with depth "related" retrieves without ever invoking the classifier', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Use Postgres for persistence', 'cli');
    vi.mocked(classifyRelationship).mockClear(); // scope the assertion to the check, not the capture

    const result = await client.checkAlignment('migrate the database', undefined, { depth: 'related' });

    expect(classifyRelationship).not.toHaveBeenCalled();
    expect(result.status).toBe('retrieved');
    expect(result.relevant_decisions.length).toBeGreaterThan(0);
    expect(result.conflicts).toEqual([]);
  });

  // Ordering only, NOT the depth property: with no candidates the method returns 'no-context'
  // before it reads `depth` at all, so removing the depth branch leaves this green (confirmed by
  // injection). It is here to pin that adding the branch did not disturb the empty case, and the
  // classifier assertion below is vacuous by construction - the retrieval test above is the one
  // that pins suppression.
  it('checkAlignment with depth "related" leaves the empty case reporting "no-context"', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.0);

    const result = await client.checkAlignment('- use js\n+ use ts', undefined, { depth: 'related' });

    expect(result.status).toBe('no-context');
    expect(result.relevant_decisions).toEqual([]);
  });

  // The widened signature accepts `title` because the cloud client does, and `align check
  // --title` documents it as materially improving adjudication. Accepting it and dropping it is
  // the same defect as dropping `depth`, one field over - and worse, because the old two-arg
  // signature at least made it visibly unsupported.
  it('checkAlignment adjudicates against the caller\'s title rather than a generic placeholder', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Use Postgres for persistence', 'cli');
    vi.mocked(classifyRelationship).mockClear();

    await client.checkAlignment('diff body', undefined, { title: 'Move the main store to MySQL' });

    expect(classifyRelationship).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Move the main store to MySQL' }),
      expect.anything(),
    );
  });

  // The default, so the assertion above cannot pass by the title being ignored in both cases.
  it('checkAlignment falls back to "Proposed change" when no title is given', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Use Postgres for persistence', 'cli');
    vi.mocked(classifyRelationship).mockClear();

    await client.checkAlignment('diff body');

    expect(classifyRelationship).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Proposed change' }),
      expect.anything(),
    );
  });

  // ALI-845 defect 3: this file used to cap the subject at diff.slice(0, 2000) - a second
  // writer of the same fact once the classifier's own buildUserPrompt is budget-derived
  // (local-relationship-classifier.test.ts's "caps each side" tests prove THAT half). This
  // is the half that makes deleting the slice safe: the gateway client must hand the
  // classifier the WHOLE diff, uncut, so the classifier's own window logic is what decides,
  // not a number unrelated to any window.
  it('checkAlignment passes the diff to the classifier uncut - capping now lives in the classifier', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Use Postgres for persistence', 'cli');
    vi.mocked(classifyRelationship).mockClear();
    const bigDiff = `diff opening line\n${'x'.repeat(60_000)}`;

    await client.checkAlignment(bigDiff);

    const [subjectArg] = vi.mocked(classifyRelationship).mock.calls[0]!;
    expect(subjectArg.summary).toContain('diff opening line');
    // Was 2,000 before ALI-845 - proves the slice is gone, not just that SOMETHING changed.
    expect(subjectArg.summary.length).toBeGreaterThan(2000);
    expect(subjectArg.summary).toBe(bigDiff);
  });

  // The split floor, driven by a score BETWEEN the two constants. A fixture above both, or
  // below both, cannot tell a split from a single threshold - it is the same shape as sending
  // the same value down two paths and calling it a precedence test.
  it('retrieves a candidate scoring between the two floors, but does not adjudicate it', async () => {
    const between = (RETRIEVAL_RELATES_THRESHOLD + RELATES_THRESHOLD) / 2;
    expect(between).toBeGreaterThan(RETRIEVAL_RELATES_THRESHOLD);
    expect(between).toBeLessThan(RELATES_THRESHOLD);
    vi.mocked(cosineSimilarity).mockReturnValue(between);
    await client.captureDecision('Use Postgres for persistence', 'cli');

    const retrieved = await client.checkAlignment('migrate the database', undefined, { depth: 'related' });
    const adjudicated = await client.checkAlignment('migrate the database', undefined, { depth: 'full' });

    // The hook sees it...
    expect(retrieved.status).toBe('retrieved');
    expect(retrieved.relevant_decisions.length).toBeGreaterThan(0);
    // ...and the adjudicating path does not, so it stays free of the LLM call it would have paid.
    expect(adjudicated.status).toBe('no-context');
    expect(adjudicated.relevant_decisions).toEqual([]);
  });

  // The other side of the boundary: an explicit 'full' adjudicates, same as no option at all.
  it('checkAlignment with explicit depth "full" still classifies the candidates', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.75);
    await client.captureDecision('Use Postgres for persistence', 'cli');
    vi.mocked(classifyRelationship).mockClear();

    await client.checkAlignment('migrate the database', undefined, { depth: 'full' });

    expect(classifyRelationship).toHaveBeenCalled();
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

  // ALI-692: `align check` is the surface agents gate on, and it was the one that learnt
  // nothing from the new diagnosis - classifier_error fell through the hint ladder to an
  // empty string, so the model that failed was recorded and then discarded one frame up.
  it('checkAlignment names the model that failed when the chain stopped on it', async () => {
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship).mockResolvedValue({ ok: false, reason: 'classifier_error' });
    vi.mocked(classifyRelationship).mockResolvedValue({ ok: false, reason: 'classifier_error', failure: { kind: 'provider_stopped', provider: 'openai', model: 'gpt-4o-mini', detail: 'HTTP 429' } });
    await client.ingestBatch([
      { source_url: 'https://jira/ABC-3', platform: 'jira', raw_text: 'Feature flag rollout', title: 'Rollout plan' },
    ]);

    const result = await client.checkAlignment('add a feature flag');

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('gpt-4o-mini');
    expect(result.message).toContain('HTTP 429');
    // Telling someone whose provider just answered to configure a provider is the
    // misdiagnosis this rung exists to prevent.
    expect(result.message).not.toMatch(/Set ANTHROPIC_API_KEY/);
  });

  it('checkAlignment stops asking after a recorded chain stop instead of retrying every candidate', async () => {
    // A recorded stop is a property of the provider, not of the candidate, so asking
    // again per candidate burns the same doomed call N times - and on a 429 it burns
    // the retry budget while `align check --advisory` is racing a 2.5s deadline.
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship).mockResolvedValue({ ok: false, reason: 'classifier_error' });
    vi.mocked(classifyRelationship).mockResolvedValue({ ok: false, reason: 'classifier_error', failure: { kind: 'provider_stopped', provider: 'openai', model: 'gpt-4o-mini', detail: 'HTTP 429' } });
    await client.ingestBatch([
      { source_url: 'https://slack.com/a', platform: 'slack', raw_text: 'Standardise on MySQL', title: 'Standardise on MySQL' },
      { source_url: 'https://slack.com/b', platform: 'slack', raw_text: 'Cache with Redis', title: 'Cache with Redis' },
      { source_url: 'https://slack.com/c', platform: 'slack', raw_text: 'Queue with SQS', title: 'Queue with SQS' },
    ]);
    // This file's beforeEach re-stubs the mock's return but does not clear its history,
    // so a call COUNT has to start from a known zero or it inherits every earlier test.
    vi.mocked(classifyRelationship).mockClear();

    const result = await client.checkAlignment('migrate the database to Postgres');

    expect(vi.mocked(classifyRelationship)).toHaveBeenCalledTimes(1);
    // The retrieved decisions still all report, so stopping early costs the human nothing.
    expect(result.status).toBe('unknown');
    expect(result.relevant_decisions.length).toBe(3);
  });

  it('checkAlignment keeps the pull hint in step with the one `align ask` prints', async () => {
    // Two writers of one fact: this hint hardcoded `ollama pull llama3.2` while ask
    // renders RECOMMENDED_OLLAMA_PULL, so the next bump makes the two commands
    // recommend different models for the identical condition.
    vi.mocked(cosineSimilarity).mockReturnValue(0.6);
    vi.mocked(classifyRelationship).mockResolvedValue({ ok: false, reason: 'unvetted_local_model' });
    await client.ingestBatch([
      { source_url: 'https://jira/ABC-4', platform: 'jira', raw_text: 'Feature flag rollout', title: 'Rollout plan' },
    ]);

    const result = await client.checkAlignment('add a feature flag');

    expect(result.message).toContain(`ollama pull ${RECOMMENDED_OLLAMA_PULL}`);
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

  // ALI-787: the model tag. Two examples - one pinning what a normal capture writes, one
  // pinning what happens when a row was written by a DIFFERENT model - because "tags new
  // rows correctly" and "degrades honestly on an old tag" are two separate behaviours and a
  // single passing case could be satisfied by either alone.
  describe('ALI-787: decision_embeddings.model', () => {
    it('captureDecision tags the new embedding with the current model', async () => {
      const captured = await client.captureDecision('Use TypeScript', 'cli');
      // A second, independent handle on the same file - the client exposes no db, and
      // opening one directly is how local-db-repo-scope.test.ts's own migration tests
      // verify state written through a different API surface than the one under test.
      const raw = createLocalDb(dbPath);
      expect(raw.getEmbeddingModel(captured.id)).toBe(EMBEDDING_MODEL_ID);
      raw.close();
    });

    it('findSimilar (via ingestOne) excludes a candidate whose embedding is tagged with a different model, even at a high cosine score', async () => {
      // A high mocked score so the only thing that can be excluding this candidate is the
      // model filter, not the similarity threshold.
      vi.mocked(cosineSimilarity).mockReturnValue(0.99);
      const stale = await client.captureDecision('Use Postgres for storage', 'cli');
      const raw = createLocalDb(dbPath);
      // Overwrite with a stale tag, as if this row survived from a retired model.
      raw.setEmbedding(stale.id, new Float32Array(384).fill(0.1), 'Xenova/some-retired-model');
      raw.close();

      // captureDecision's `related` is already decision ids (ingestOne's {decisionId,score}
      // objects, narrowed by captureDecision itself) - see createLocalGatewayClient above.
      const result = await client.captureDecision('Switch storage to Postgres', 'cli');
      expect(result.related).not.toContain(stale.id);
    });

    it('checkDrift refuses to compare against a stale-model embedding, and says why', async () => {
      const captured = await client.captureDecision('Use TypeScript', 'cli');
      const raw = createLocalDb(dbPath);
      raw.setEmbedding(captured.id, new Float32Array(384).fill(0.1), 'Xenova/some-retired-model');
      raw.close();

      const result = await client.checkDrift(captured.id, 'some content to compare', 'code');
      expect(result.score).toBeNull();
      expect(result.drifted).toBeNull();
      // Names BOTH models (Copilot review, #273): the stale one so the user knows what to
      // re-run, the current one so they can confirm a re-import actually landed rather than
      // guessing whether the graph moved on since this note was printed.
      expect(result.note).toMatch(/some-retired-model/);
      expect(result.note).toContain(EMBEDDING_MODEL_ID);
    });

    it('checkDrift still compares normally when the stored model is untagged (null)', async () => {
      const captured = await client.captureDecision('Use TypeScript', 'cli');
      const raw = createLocalDb(dbPath);
      // 2-arg call: no model, same as a pre-ALI-787 row the migration somehow missed.
      raw.setEmbedding(captured.id, new Float32Array(384).fill(0.1));
      raw.close();

      const result = await client.checkDrift(captured.id, 'some content to compare', 'code');
      expect(result).toHaveProperty('score');
      expect(result.score).not.toBeNull();
    });
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