import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Test list (Given / When / Then, two examples per rule)
 *
 * The shape this pins is a real one, from a copy of PrimeFoldTools/Andon (a user's repo): an edit that
 * switches the claim-check hook from warn to off. `align check` embedded the WHOLE diff (headers, the
 * file path, three lines of context each side), which sits next to every commit that touched that
 * file. The decision that states the rule, an entry in DEFECT_LEDGER.md ("Default to warn"), ranked 40th
 * of 66 rows over the floor by the diff and 1st by the changed lines alone. The check keeps five, so it
 * named five commits about the same file and never the rule the edit reverses. The edit hook asks with
 * the changed text only and found it.
 *
 * Which embedding stands in: hand-built unit vectors, as in edit-intent-retrieval.test.ts. The real
 * model run over the Andon graph is a measurement, reported in the PR, not a test.
 *
 *  1. Given six commits near the diff and a ledger entry near the changed lines only, then check retrieves the entry.
 *  2. Given a second such entry, then both are retrieved, and an unrelated decision is not.
 *  3. Given three such entries, then only the changed lines' best two take places, and the dense top three stay first, in order.
 *  4. Given a change the changed lines add nothing to (nothing near them), then the five are the dense five, in order.
 *  5. Given the changed lines' best rows already in the dense five, then the five are unchanged.
 *  6. Given an entry under the floor for the changed lines, then it is not retrieved.
 *  7. Given an entry exactly at the floor for the changed lines, then it is retrieved.
 *  8. changedLinesOf keeps a removed SQL comment and an added `++i;`, and skips the file header (see diff-changed-lines.test.ts).
 */

const DIM = 384;
const unit = (parts: Record<number, number>): Float32Array => {
  const v = new Float32Array(DIM);
  for (const [i, x] of Object.entries(parts)) v[Number(i)] = x;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};

const vectors = new Map<string, Float32Array>();
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async (text: string) => vectors.get(text) ?? new Float32Array(DIM)),
  cosineSimilarity: (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; },
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'refines', 'implements', 'depends_on', 'relates_to'],
}));

import { createLocalGatewayClient, RETRIEVAL_RELATES_THRESHOLD } from '../lib/local-gateway-client.js';
import { createLocalDb } from '../lib/local-db.js';
import { EMBEDDING_MODEL_ID, getEmbedding } from '../lib/local-embeddings.js';

const DIFF = [
  'diff --git a/hooks/claim_check_hook.py b/hooks/claim_check_hook.py',
  'index 1111111..2222222 100644',
  '--- a/hooks/claim_check_hook.py',
  '+++ b/hooks/claim_check_hook.py',
  '@@ -103,7 +103,7 @@ STALE_RETRY_STEP_S = 0.1',
  ' STALE_RETRY_STEP_S = 0.1        # re-reading the transcript this often',
  '-DEFAULT_MODE = "warn"           # warn | block | off',
  '+DEFAULT_MODE = "off"            # warn | block | off',
  ' OVERLAP_MIN_TOKENS = 1          # a fresh log entry must share >=N content tokens',
  '',
].join('\n');
// The removed line, then the added line, each without its marker, no headers, no context.
const CHANGED = 'DEFAULT_MODE = "warn"           # warn | block | off\nDEFAULT_MODE = "off"            # warn | block | off';

describe('align check also asks retrieval about the changed lines alone', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;
  const ids: Record<string, string> = {};

  const seed = (name: string, embedding: Float32Array) => {
    const db = createLocalDb(dbPath);
    const id = db.insertDecision({ title: name, summary: `${name} summary`, sourceUrl: `https://example.test/${name}`, platform: 'manual' });
    db.setEmbedding(id, embedding, EMBEDDING_MODEL_ID);
    ids[name] = id;
    db.close();
  };
  const check = async () => (await client.checkAlignment(DIFF, 'main', {})).relevant_decisions.map((d) => d.id);

  beforeEach(() => {
    vi.stubEnv('ALIGN_DETECTOR', 'v0');
    vi.mocked(getEmbedding).mockImplementation(async (t: string) => vectors.get(t) ?? new Float32Array(DIM));
    vectors.clear();
    dbPath = path.join(os.tmpdir(), `align-changed-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    vectors.set(DIFF, unit({ 0: 1 }));
    vectors.set(CHANGED, unit({ 1: 1 }));
    // Six commits about the same file: ~0.65 to the diff, nothing to the changed lines.
    for (let i = 0; i < 6; i++) seed(`commit-${i}`, unit({ 0: 0.65 - i * 0.01, [10 + i]: 0.76 }));
    // The ledger entry: 0.45 to the diff (over the floor, rank 7), 0.89 to the changed lines.
    seed('ledger-default-to-warn', unit({ 0: 0.45, 1: 0.89 }));
    seed('unrelated', unit({ 2: 1 }));
    client = createLocalGatewayClient(dbPath);
  });
  afterEach(() => {
    client.close();
    vi.unstubAllEnvs();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('retrieves a decision that states the rule the changed lines touch, past six same-file commits', async () => {
    expect(await check()).toContain(ids['ledger-default-to-warn']);
  });

  it('retrieves a second such decision too, and not the unrelated one', async () => {
    seed('ledger-second-rule', unit({ 0: 0.44, 1: 0.9 }));
    const got = await check();
    expect(got).toContain(ids['ledger-default-to-warn']);
    expect(got).toContain(ids['ledger-second-rule']);
    expect(got).not.toContain(ids['unrelated']);
  });

  it('gives the changed lines two places at most, and keeps the dense top three first, in order', async () => {
    seed('ledger-second-rule', unit({ 0: 0.44, 1: 0.9 }));
    seed('ledger-third-rule', unit({ 0: 0.43, 1: 0.91 }));
    const got = await check();
    expect(got).toHaveLength(5);
    expect(got.slice(0, 3)).toEqual([0, 1, 2].map((i) => ids[`commit-${i}`]));
    expect(got.slice(3)).toEqual([ids['ledger-third-rule'], ids['ledger-second-rule']]);
    expect(got).not.toContain(ids['ledger-default-to-warn']);
  });

  it('keeps the dense five in order when the changed lines add nothing', async () => {
    vectors.set(CHANGED, unit({ 3: 1 })); // near no row
    const got = await check();
    expect(got.slice(0, 5)).toEqual([0, 1, 2, 3, 4].map((i) => ids[`commit-${i}`]));
  });

  it('changes nothing when the changed lines best rows are already in the dense five', async () => {
    vectors.set(CHANGED, unit({ 10: 1, 11: 0.5 })); // near commit-0 and commit-1 only
    const got = await check();
    expect(got.slice(0, 5)).toEqual([0, 1, 2, 3, 4].map((i) => ids[`commit-${i}`]));
  });

  it('keeps every dense row when fewer than five exist and the changed lines add two', async () => {
    client.close();
    fs.unlinkSync(dbPath);
    dbPath = path.join(os.tmpdir(), `align-changed-few-${process.pid}-${Date.now()}.db`);
    for (const i of [0, 1]) seed(`commit-${i}`, unit({ 0: 0.65 - i * 0.01, [10 + i]: 0.76 }));
    // Under the floor for the diff (0.2 < 0.30), so only the changed lines retrieve them: the dense rows are the two commits.
    seed('ledger-second-rule', unit({ 0: 0.2, 1: 0.98 }));
    seed('ledger-third-rule', unit({ 0: 0.2, 1: 0.99 }));
    client = createLocalGatewayClient(dbPath);
    const got = await check();
    expect(got).toHaveLength(4);
    expect(got.slice(0, 2)).toEqual([ids['commit-0'], ids['commit-1']]);
  });

  it('does not retrieve an entry just under the floor for the changed lines', async () => {
    const under = RETRIEVAL_RELATES_THRESHOLD - 0.01;
    vectors.set(CHANGED, unit({ 4: 1 }));
    seed('under', unit({ 4: under, 5: Math.sqrt(1 - under ** 2) }));
    expect(await check()).not.toContain(ids['under']);
  });

  it('retrieves an entry exactly at the floor for the changed lines', async () => {
    vectors.set(CHANGED, unit({ 4: 1 }));
    seed('at', unit({ 4: RETRIEVAL_RELATES_THRESHOLD, 5: Math.sqrt(1 - RETRIEVAL_RELATES_THRESHOLD ** 2) }));
    expect(await check()).toContain(ids['at']);
  });
});
