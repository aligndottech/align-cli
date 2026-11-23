import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Ranking is driven by the mocked cosineSimilarity below; see helpers/mocked-cosine-matrix.ts.
vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
// Two embedding "topics" by text: a query and a rule about routes share one, an ADR that only
// says what it replaced sits on the other, so retrieval never returns the ADR by itself.
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async (text: string) => new Float32Array(384).fill(text.includes('Supersedes') ? 2 : 1)),
  cosineSimilarity: vi.fn((a: Float32Array, b: Float32Array) => (a[0] === b[0] ? 0.9 : 0)),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['relates_to'],
}));

import { buildRelatedOutput } from '../commands/check.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

/*
 * TEST LIST
 *
 * 1. Given an ADR saying "Supersedes the REST-only rule in CLAUDE.md" and a CLAUDE.md row,
 *    when both are ingested (either order), then a partial supersession from the ADR to the
 *    CLAUDE.md row is recorded.
 *    1b. Same with "Supersedes the logging rule in AGENTS.md" and an AGENTS.md row.
 * 2. Given that link, when the edit hook runs on a bare REST route edit and retrieval returns
 *    only the CLAUDE.md row, then the output names the superseding ADR and tags the old row
 *    "partly replaced", and does not mark it "(replaced)".
 *    2b. Same with a different route snippet.
 * 3. Control: the other rules in the same CLAUDE.md row stay unhidden. A moment edit still
 *    shows the row, tagged only as partly replaced, never as fully replaced.
 * 4. Negative, each creating no link and not throwing:
 *    4a. "supersedes" in prose that names no file or ADR.
 *    4b. a file the graph does not hold.
 *    4c. two ADRs with the same title: only the one holding the sentence links.
 *    4d. a file the graph holds whose rows share no word with the superseded rule, when it has several rows.
 * 5. Ingesting the ADR twice leaves one link.
 */

const ADR_URL = 'https://github.com/acme/app/blob/main/docs/adr/0004-graphql.md';
const CLAUDE_URL = 'https://github.com/acme/app/blob/main/CLAUDE.md#conventions';
const CLAUDE_TEXT = ['- Use moment for dates.', '- Use REST routes for new endpoints.', '- Use Jest for tests.'].join('\n');
const ADR_TEXT = 'New endpoints are GraphQL. Supersedes the REST-only rule in CLAUDE.md.';

let dir: string;
let dbPath: string;
const opened: Array<{ close(): void }> = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-partial-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => {
  for (const h of opened.splice(0)) h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const client = () => {
  const c = createLocalGatewayClient(dbPath, { cwd: dir });
  opened.push(c);
  return c;
};
type Item = { source_url: string; title: string; raw_text: string };
const doc = (i: Item) => ({ ...i, platform: 'docs', created_at: undefined });
const adr = (text = ADR_TEXT, title = 'ADR 0004: GraphQL for new endpoints', url = ADR_URL): Item => ({ source_url: url, title, raw_text: text });
const claude = (url = CLAUDE_URL, title = 'Conventions', text = CLAUDE_TEXT): Item => ({ source_url: url, title, raw_text: text });

async function ingest(c: ReturnType<typeof client>, ...items: Item[]): Promise<string[]> {
  const { snapshots } = await c.ingestBatch(items.map(doc));
  return snapshots.map((s) => s.id);
}

/** Rows in the partial-supersession table; 0 when the table does not exist yet. */
function storedLinks(): number {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const t = raw.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'decision_partial_supersessions'`).get();
    return t === undefined ? 0 : (raw.prepare('SELECT COUNT(*) AS n FROM decision_partial_supersessions').get() as { n: number }).n;
  } finally { raw.close(); }
}

const claudeOut = (out: unknown): string => (out as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
async function hookText(c: ReturnType<typeof client>, edit: string): Promise<string> {
  const res = await c.checkAlignment(edit, undefined, { depth: 'related' });
  return claudeOut(buildRelatedOutput(res.relevant_decisions, { pre: true, format: 'claude', blockOnCritical: false }));
}
const partlyBy = async (c: ReturnType<typeof client>, id: string, edit: string) =>
  (await c.checkAlignment(edit, undefined, { depth: 'related' })).relevant_decisions.find((d) => d.id === id)?.partly_replaced_by;

describe('1. an ADR that names a rule in another file records a partial supersession', () => {
  it('ADR first, then the CLAUDE.md row', async () => {
    const c = client();
    const [, claudeId] = await ingest(c, adr(), claude());
    expect(storedLinks()).toBe(1);
    expect((await partlyBy(c, claudeId!, 'app.get("/users", handler)'))?.map((d) => d.title)).toEqual(['ADR 0004: GraphQL for new endpoints']);
  });

  it('the CLAUDE.md row first, then the ADR', async () => {
    const c = client();
    const [claudeId] = await ingest(c, claude(), adr());
    expect(storedLinks()).toBe(1);
    expect((await partlyBy(c, claudeId!, 'app.get("/users", handler)'))?.length).toBe(1);
  });

  it('another phrasing and file: the logging rule in AGENTS.md', async () => {
    const c = client();
    const agents = claude('https://github.com/acme/app/blob/main/AGENTS.md#style', 'Style', '- Log with console.log.\n- Keep functions short.');
    const [, agentsId] = await ingest(c, adr('Structured logs now. Supersedes the logging rule in AGENTS.md.', 'ADR 0007: Structured logging', 'https://github.com/acme/app/blob/main/docs/adr/0007-logging.md'), agents);
    expect(storedLinks()).toBe(1);
    expect((await partlyBy(c, agentsId!, 'console.log("x")'))?.map((d) => d.title)).toEqual(['ADR 0007: Structured logging']);
  });
});

describe('2. the edit hook names the superseding ADR on a partly replaced rule', () => {
  it.each(['app.get("/users", handler)', 'router.post("/orders", create)'])('bare route edit %s', async (edit) => {
    const c = client();
    await ingest(c, adr(), claude());
    const out = await hookText(c, edit);
    expect(out).toContain('ADR 0004: GraphQL for new endpoints');
    expect(out).toMatch(/Conventions \(partly replaced by: ADR 0004/);
    expect(out).not.toContain('(replaced');
  });
});

describe('3. the other rules in the same row are not hidden', () => {
  it('a moment edit still shows the row, as partly replaced and never fully replaced', async () => {
    const c = client();
    await ingest(c, adr(), claude());
    const out = await hookText(c, "import moment from 'moment'");
    expect(out).toContain('Conventions (partly replaced by: ADR 0004');
    expect(out).toContain('Use moment for dates.');
    expect(out).not.toContain('(replaced');
  });
});

describe('4. a sentence that resolves to nothing creates nothing', () => {
  it('supersedes in prose naming no file or ADR', async () => {
    const c = client();
    await ingest(c, claude(), adr('This supersedes everything we did before, in practice.'));
    expect(storedLinks()).toBe(0);
  });

  it.each(['NOTES.md', 'docs/handbook.md'])('a file the graph does not hold: %s', async (file) => {
    const c = client();
    await ingest(c, claude(), adr(`Supersedes the REST-only rule in ${file}.`));
    expect(storedLinks()).toBe(0);
  });

  it('two ADRs with one title: only the one holding the sentence links', async () => {
    const c = client();
    const other = adr('New endpoints are GraphQL.', 'ADR 0004: GraphQL for new endpoints', 'https://github.com/acme/app/blob/main/docs/adr/0004b.md');
    const [, , claudeId] = await ingest(c, other, adr(), claude());
    expect(storedLinks()).toBe(1);
    expect((await partlyBy(c, claudeId!, 'app.get("/users", handler)'))?.length).toBe(1);
  });

  it('a file with several rows, none sharing a word with the rule', async () => {
    const c = client();
    const second = claude('https://github.com/acme/app/blob/main/CLAUDE.md#testing', 'Testing', '- Run vitest before pushing.');
    await ingest(c, claude(undefined, 'Dates', '- Use moment for dates.'), second, adr('Supersedes the GraphQL rule in CLAUDE.md.'));
    expect(storedLinks()).toBe(0);
  });
});

describe('5. ingesting twice', () => {
  it('leaves one link', async () => {
    const c = client();
    await ingest(c, adr(), claude());
    await ingest(c, adr(), claude());
    expect(storedLinks()).toBe(1);
  });
});
