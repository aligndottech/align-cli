import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmDir } from './helpers/rm-dir.js';

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

// The dense score of a stored decision is picked by the first vector slot, which is the slot the text names
// in its trailing "(x)" tag. Synthetic titles only.
const TAGS = 'abcdefghijkl';
const slotOf = (t: string) => { const m = /\(([a-l])\)/.exec(t); return m ? TAGS.indexOf(m[1]!) + 1 : 0; };

let dir: string;
let client: ReturnType<typeof createLocalGatewayClient>;
let dense: Record<number, number>;

function wire(scores: Record<number, number>) {
  dense = scores;
  vi.mocked(getEmbedding).mockImplementation(async (t: string) => {
    const v = new Float32Array(384).fill(0.1);
    v[0] = slotOf(t);
    return v;
  });
  vi.mocked(cosineSimilarity).mockImplementation((_q: Float32Array, stored: Float32Array) => dense[stored[0]!] ?? 0);
}

const order = (rs: Array<{ title: string }>) => rs.map(r => /\((\w)\)$/.exec(r.title)?.[1]);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'align-hybrid-'));
  client = createLocalGatewayClient(path.join(dir, 'g.db'));
});
afterEach(() => { client.close(); rmDir(dir); });

const commit = (n: number) => `https://github.com/o/r/commit/${String(n).repeat(40).slice(0, 40)}`;
async function addGit(title: string, body: string, n: number) {
  await client.ingestBatch([{ raw_text: `${title}\n\n${body}\n\nAuthor: A <a@b.c>\nDate: 2025-01-01`, platform: 'git', title, source_url: commit(n) }], { classify: false });
}

describe('local search on git commits: dense and lexical rankings fused', () => {
  const TITLES = [
    'docs: explain how routing works in the guide (a)',
    'docs: more routing notes and routing examples (b)',
    'feat: switch the router to zorblax-match (c)',
    'chore: tidy the release notes (d)',
    'docs: quuxmatic appendix (e)',
  ];
  beforeEach(async () => {
    wire({ 1: 0.7, 2: 0.65, 3: 0.4, 4: 0.3, 5: 0.1 });
    for (const [i, t] of TITLES.entries()) await addGit(t, i === 3 ? 'Release notes are noisy.' : 'Body text.', i + 1);
  });

  it('a lexically exact commit with a lower dense score overtakes higher-dense mentions', async () => {
    const { results } = await client.searchDecisions('why did we switch to zorblax-match', 4, undefined, { all: true });
    expect(order(results)[0]).toBe('c');
    // The reported score stays the dense similarity, not a fused number.
    expect(results[0]!.similarity).toBe(0.4);
  });

  it('a kebab identifier is found from its parts: "zorblax match" hits "zorblax-match"', async () => {
    const { results } = await client.searchDecisions('why do we use zorblax match', 4, undefined, { all: true });
    expect(order(results)[0]).toBe('c');
  });

  it('a question sharing no term with any commit keeps the dense order', async () => {
    const { results } = await client.searchDecisions('why was kubernetes mentioned', 4, undefined, { all: true });
    expect(order(results)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a row only the lexical ranking found is shown when its dense score is under the search floor but over the lexical floor', async () => {
    wire({ 1: 0.7, 2: 0.65, 3: 0.2, 4: 0.3, 5: 0.1 });
    const { results } = await client.searchDecisions('why zorblax-match', 4, undefined, { all: true });
    expect(order(results)).toContain('c');
  });

  it('but not when it has essentially no semantic resemblance (dense 0.1)', async () => {
    const { results } = await client.searchDecisions('why quuxmatic', 4, undefined, { all: true });
    expect(order(results)).not.toContain('e');
  });

  it('a second rare word in another commit: a different identifier example', async () => {
    const { results } = await client.searchDecisions('why release', 4, undefined, { all: true });
    expect(order(results)[0]).toBe('d');
  });

  it('finds a commit from the reason in its body, which the title does not state', async () => {
    await addGit('chore: bump the thing (f)', 'The old release was yanked after a memory leak in the worker pool.', 6);
    dense[6] = 0.3;
    const { results } = await client.searchDecisions('why did we leave the worker pool', 4, undefined, { all: true });
    expect(order(results)[0]).toBe('f');
  });

  it('plural against singular: a question about processes finds the commit about a process', async () => {
    await addGit('feat: spawn one process per job (g)', 'Isolation.', 7);
    dense[7] = 0.3;
    const { results } = await client.searchDecisions('why do we spawn processes', 4, undefined, { all: true });
    expect(order(results)[0]).toBe('g');
  });

  it('identifier tokens match: node18, pino', async () => {
    await addGit('chore: require node18 (h)', 'Old versions are gone.', 8);
    await addGit('chore: bump pino (i)', 'Logger upgrade.', 9);
    dense[8] = 0.3; dense[9] = 0.3;
    expect(order((await client.searchDecisions('why node 18', 4, undefined, { all: true })).results)[0]).toBe('h');
    expect(order((await client.searchDecisions('why pino', 4, undefined, { all: true })).results)[0]).toBe('i');
  });

  it('the same question twice gives the same order', async () => {
    const a = await client.searchDecisions('why did we switch to zorblax-match', 5, undefined, { all: true });
    const b = await client.searchDecisions('why did we switch to zorblax-match', 5, undefined, { all: true });
    expect(order(a.results)).toEqual(order(b.results));
  });

  it('degrades to the dense order when the lexical index cannot be used', async () => {
    const { createLexicalStore } = await import('../lib/lexical-store.js');
    expect(createLexicalStore).toBeTypeOf('function');
    // A graph whose lexical tables are blocked by a view of the same name: the search must still answer.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path.join(dir, 'g.db'));
    raw.exec('CREATE VIEW lex_doc AS SELECT 1 AS decision_id');
    raw.close();
    const { results } = await client.searchDecisions('why did we switch to zorblax-match', 4, undefined, { all: true });
    expect(order(results)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('on a mixed graph, a git commit that only matches lexically does not suppress the empty answer', async () => {
    // Every dense score is under the 0.25 search floor, so the answer is empty, as it was before the lexical list.
    wire({ 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2, 5: 0.2 });
    await client.captureDecision('we agreed on slack to use zorblax-match too (k)', 'slack');
    const { results } = await client.searchDecisions('why zorblax-match', 4, undefined, { all: true });
    expect(results).toEqual([]);
  });
});
