/**
 * The edit hook (`checkAlignment` with depth 'related') cut its five rows from the dense order alone, so a
 * decision that names the identifier an edit touches lost its place to five that merely sound like it.
 *
 * Test List:
 * 1. with a stored keyword index, the row past dense rank five that names the edit's identifier is shown
 * 2. it keeps its dense similarity: the fused rank orders rows, it does not rescore them
 * 3. a row under the hook's dense floor is not shown, however well its words match
 * 4. a graph that was never searched answers in dense order, and the hook builds no index
 * 5. pair: an adjudicated check (no depth) keeps the dense five
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(),
  cosineSimilarity: vi.fn(),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'refines', 'implements', 'depends_on', 'relates_to'],
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { cosineSimilarity, getEmbedding } from '../lib/local-embeddings.js';

beforeEach(() => { vi.stubEnv('ALIGN_DETECTOR', 'v0'); });
afterEach(() => { vi.unstubAllEnvs(); });

// Slot comes from "(sN)" in the title. A text with no slot is the edit, at slot 9.
const slotOf = (t: string) => Number(/\(s(\d+)\)/.exec(t)?.[1] ?? 0);
const DENSE: Record<number, number> = { 1: 0.6, 2: 0.58, 3: 0.56, 4: 0.54, 5: 0.52, 6: 0.46, 7: 0.2 };
const EDIT = 'const repo = repoFromRemoteUrl(remote);';
const row = (slot: number, title: string) => ({ title: `${title} (s${slot})`, raw_text: `${title} (s${slot})`, created_at: `2026-10-0${slot}T10:00:00Z`, platform: 'git', source_url: `https://github.com/acme/argus/commit/${slot}` });

describe('edit hook retrieval: the dense rank fused with the stored keyword rank', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;
  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `align-check-keyword-${Date.now()}-${Math.random()}.db`);
    // Run from outside any git repo: the check is scoped to the folder's repo, and these fixtures name repos of their own.
    client = createLocalGatewayClient(dbPath, { cwd: os.tmpdir() });
    const vec = (t: string) => { const v = new Float32Array(384).fill(0.1); v[0] = slotOf(t) || 9; return v; };
    vi.mocked(getEmbedding).mockImplementation(async (t: string) => vec(t));
    vi.mocked(cosineSimilarity).mockImplementation((q: Float32Array, s: Float32Array) => (q[0] === 9 ? DENSE[s[0]!] ?? 0 : q[0] === s[0] ? 1 : 0));
    await client.ingestBatch([
      ...[1, 2, 3, 4, 5].map(n => row(n, `Tick rate decision number ${n}`)),
      row(6, 'Resolve the repository with repoFromRemoteUrl'),
      row(7, 'repoFromRemoteUrl falls back to the folder name'),
    ], { classify: false });
  });
  afterEach(() => { client.close(); if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); });

  const tags = (xs: Array<{ title: string }>) => xs.map(x => /\((s\d+)\)/.exec(x.title)?.[1]);
  const hook = async () => (await client.checkAlignment(EDIT, 'src/lib/repo.ts', { depth: 'related' })).relevant_decisions;
  // Any search builds the index, as `align ask` and `align search` do.
  const searchOnce = () => client.searchDecisions('tick rate', 5, undefined, { all: true });

  it('shows the decision that names the identifier the edit touches, in place of the fifth that only sounds like it', async () => {
    await searchOnce();
    expect(tags(await hook())).toEqual(['s6', 's1', 's2', 's3', 's4']);
  });

  it('reports the dense similarity of a row the keyword rank moved', async () => {
    await searchOnce();
    expect((await hook()).find(d => /\(s6\)/.test(d.title))!.similarity).toBe(0.46);
  });

  it('does not show a row under the dense floor, however well its words match', async () => {
    await searchOnce();
    expect(tags(await hook())).not.toContain('s7');
  });

  it('answers in dense order on a graph that was never searched, and builds no index to do it', async () => {
    expect(tags(await hook())).toEqual(['s1', 's2', 's3', 's4', 's5']);
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('lex_doc', 'lex_term')`).get()).toEqual({ n: 0 });
    } finally { raw.close(); }
  });

  it('keeps the dense five for an adjudicated check', async () => {
    await searchOnce();
    expect(tags((await client.checkAlignment(EDIT, 'src/lib/repo.ts')).relevant_decisions)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });
});
