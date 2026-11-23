import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
import { deleteDecisionWithDependents } from '../lib/local-db-migrate.js';
import { applyJudgement } from '../lib/curation/mark.js';
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

const client = (o: { judgeId?: string; cwd?: string } = {}) => {
  const c = createLocalGatewayClient(dbPath, { cwd: dir, ...o });
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

describe('3. the other rules in the same row are returned as stored', () => {
  it('a moment edit returns the row text verbatim and the tag names only the ADR', async () => {
    const c = client();
    const [, claudeId] = await ingest(c, adr(), claude());
    const res = await c.checkAlignment("import moment from 'moment'", undefined, { depth: 'related' });
    const row = res.relevant_decisions.find((d) => d.id === claudeId)!;
    expect(row.summary).toBe(CLAUDE_TEXT);
    expect(row.status).toBeUndefined();
    expect(row.partly_replaced_by).toEqual([{ id: expect.any(String), title: 'ADR 0004: GraphQL for new endpoints' }]);
    const out = await hookText(c, "import moment from 'moment'");
    expect(out).toContain('Use moment for dates.');
    expect(out).toContain('Use Jest for tests.');
    expect(out.match(/partly replaced by/g)).toHaveLength(1);
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

const dated = (title: string, text: string, file = 'CLAUDE.md', repo = 'acme/app', branchPath = ''): Item =>
  ({ source_url: `https://github.com/${repo}/blob/main/${branchPath}${file}#${title.toLowerCase()}`, title, raw_text: text });
const note = (sentence: string, repo = 'acme/app'): Item => adr(`New endpoints are GraphQL. ${sentence}`, 'ADR 0004: GraphQL for new endpoints', `https://github.com/${repo}/blob/main/docs/adr/0004.md`);

describe('6. rows of another repository are never linked', () => {
  it.each([
    ['CLAUDE.md', 'Supersedes the REST rule in CLAUDE.md.'],
    ['AGENTS.md', 'Supersedes the logging rule in AGENTS.md.'],
  ])('an acme/app ADR does not link other/svc %s', async (file, sentence) => {
    const c = client();
    await ingest(c, note(sentence), dated('Rules', '- REST routes. logging.', file, 'other/svc'));
    expect(storedLinks()).toBe(0);
  });

  it('a scoped hook never lists or tags with an ADR from outside its repository', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: dir });
    const c = client();
    const [, rulesId] = await ingest(c, note('Supersedes the REST rule in CLAUDE.md.', 'other/svc'), dated('Rules', '- Use REST routes.'));
    expect(storedLinks()).toBe(0);
    const res = await c.checkAlignment('app.get("/users", handler)', undefined, { depth: 'related' });
    expect(res.relevant_decisions.map((d) => d.id)).toEqual([rulesId]);
    expect(res.relevant_decisions[0]!.partly_replaced_by).toBeUndefined();
  });
});

describe('6b. an unattributed row is not a wildcard', () => {
  const local = (title: string, text: string): Item => ({ source_url: `file:///work/${title}/CLAUDE.md`, title, raw_text: text });
  it('a local ADR does not link a repository row of the same file name', async () => {
    const c = client();
    await ingest(c, adr('Supersedes the REST rule in CLAUDE.md.', 'ADR local', 'file:///work/adr/0004.md'), dated('Rules', '- Use REST routes.', 'CLAUDE.md', 'orgb/svc'));
    expect(storedLinks()).toBe(0);
  });
  it('a repository ADR does not link a local row', async () => {
    const c = client();
    await ingest(c, note('Supersedes the REST rule in CLAUDE.md.', 'orgb/svc'), local('rules', '- Use REST routes.'));
    expect(storedLinks()).toBe(0);
  });
  it('two unattributed rows still link', async () => {
    const c = client();
    await ingest(c, adr('Supersedes the REST rule in CLAUDE.md.', 'ADR local', 'file:///work/adr/0004.md'), local('rules', '- Use REST routes.'));
    expect(storedLinks()).toBe(1);
  });
});

describe('7. the rule word picks the row, in any case', () => {
  it.each([
    ['Supersedes the REST rule in CLAUDE.md.', 'REST routes', 'moment'],
    ['Supersedes the Jest rule in CLAUDE.md.', 'Jest tests', 'moment'],
  ])('%s', async (sentence, wanted, other) => {
    const c = client();
    // Rows first, the ADR last: arriving after a lone row would let the single-row fallback link it.
    const [hit, miss] = await ingest(c, dated('Routes', `- Use ${wanted}.`), dated('Dates', `- Use ${other} for dates.`), note(sentence));
    expect(storedLinks()).toBe(1);
    expect(await partlyBy(c, hit!, 'use')).toHaveLength(1);
    expect(await partlyBy(c, miss!, 'use')).toBeUndefined();
  });
});

describe('8. a file that gains a row re-resolves the ADRs naming it', () => {
  it.each([
    ['Supersedes the REST rule in CLAUDE.md.', '- Use REST routes.'],
    ['Supersedes the Jest rule in CLAUDE.md.', '- Use Jest for tests.'],
  ])('%s: the single-row fallback link moves to the row that matches', async (sentence, rule) => {
    const c = client();
    const [, a] = await ingest(c, note(sentence), dated('Dates', '- Use moment for dates.'));
    expect(await partlyBy(c, a!, 'use')).toHaveLength(1); // the fallback: the file's only row
    const [b] = await ingest(c, dated('Rules', rule));
    expect(storedLinks()).toBe(1);
    expect(await partlyBy(c, b!, 'use')).toHaveLength(1);
    expect(await partlyBy(c, a!, 'use')).toBeUndefined();
  });
});

describe('9. only a decision-shaped sentence counts', () => {
  it.each([
    'Supersedes nothing, but the logging is done in CLAUDE.md now.',
    'Supersedes the old plan, see the rule in CLAUDE.md.',
    'Supersedes the logging in CLAUDE.md.',
  ])('%s links nothing', async (sentence) => {
    const c = client();
    await ingest(c, note(sentence), dated('Rules', '- Use REST routes and logging.'));
    expect(storedLinks()).toBe(0);
  });

  it.each(['Supersedes the GraphQL convention in CLAUDE.md.', 'Supersedes the endpoint policy in CLAUDE.md.'])('%s links the only row', async (sentence) => {
    const c = client();
    await ingest(c, note(sentence), dated('Rules', '- Use REST routes.'));
    expect(storedLinks()).toBe(1);
  });
});

describe('10. a markdown link or a dotted rule name', () => {
  it.each([
    ['Supersedes the REST rule in [CLAUDE.md](../CLAUDE.md).', 'CLAUDE.md'],
    ['Supersedes the logging rule in [the agents file](docs/AGENTS.md).', 'docs/AGENTS.md'],
  ])('%s', async (sentence, file) => {
    const c = client();
    const [, row] = await ingest(c, note(sentence), dated('Rules', '- REST routes. logging.', file.split('/').pop()!, 'acme/app', file.includes('/') ? 'docs/' : ''));
    expect(storedLinks()).toBe(1);
    expect(await partlyBy(c, row!, 'use')).toHaveLength(1);
  });

  it.each([
    ['Supersedes the Node.js rule in CLAUDE.md.', 'Use Node 18.', 'Use moment.'],
    ['Supersedes the Express.js rule in CLAUDE.md.', 'Use express handlers.', 'Use moment.'],
  ])('%s picks the row with the word', async (sentence, wanted, other) => {
    const c = client();
    const [, hit, miss] = await ingest(c, note(sentence), dated('A', wanted), dated('B', other));
    expect(await partlyBy(c, hit!, 'use')).toHaveLength(1);
    expect(await partlyBy(c, miss!, 'use')).toBeUndefined();
  });
});

describe('11. a file name matches a whole path segment', () => {
  it('docs/OLD-CLAUDE.md is not CLAUDE.md', async () => {
    const c = client();
    await ingest(c, note('Supersedes the REST rule in CLAUDE.md.'), dated('Rules', '- Use REST routes.', 'OLD-CLAUDE.md', 'acme/app', 'docs/'));
    expect(storedLinks()).toBe(0);
  });

  it('a vendored copy is taken only when the rule word picks it', async () => {
    const c = client();
    const [, top, vendored] = await ingest(c, note('Supersedes the REST rule in CLAUDE.md.'), dated('Dates', '- Use moment.'), dated('Vendor', '- Use REST routes.', 'CLAUDE.md', 'acme/app', 'vendor/'));
    expect(await partlyBy(c, vendored!, 'use')).toHaveLength(1);
    expect(await partlyBy(c, top!, 'use')).toBeUndefined();
  });
});

describe('12. a hidden or replaced ADR is neither listed nor named', () => {
  const me = { judgeId: 'me', judgeLabel: null };
  it('a superseded ADR is not appended and the old row carries no tag', async () => {
    const c = client({ judgeId: 'me' });
    const [adrId, rowId, newer] = await ingest(c, adr(), claude(), { source_url: 'https://github.com/acme/app/blob/main/docs/adr/0009.md', title: 'ADR 0009', raw_text: 'Supersedes nothing at all here.' });
    applyJudgement({ dbPath, judge: me, origin: { via: 'cli' } }, { action: 'replaces', newer: newer!, older: adrId! });
    const res = await c.checkAlignment('app.get("/users", handler)', undefined, { depth: 'related' });
    expect(res.relevant_decisions.map((d) => d.id)).toEqual([rowId]);
    expect(res.relevant_decisions[0]!.partly_replaced_by).toBeUndefined();
  });

  it('a not-a-decision ADR is not appended and the old row carries no tag', async () => {
    const c = client({ judgeId: 'me' });
    const [adrId, rowId] = await ingest(c, adr(), claude());
    applyJudgement({ dbPath, judge: me, origin: { via: 'cli' } }, { action: 'not-a-decision', id: adrId! });
    const res = await c.checkAlignment('app.get("/users", handler)', undefined, { depth: 'related' });
    expect(res.relevant_decisions.map((d) => d.id)).toEqual([rowId]);
    expect(res.relevant_decisions[0]!.partly_replaced_by).toBeUndefined();
  });

  it.each(['not-a-decision', 'replaced'])('when the newest ADR is %s, the older valid one is listed and named', async (how) => {
    const c = client({ judgeId: 'me' });
    const older = adr('Supersedes the REST rule in CLAUDE.md.', 'ADR 0004: GraphQL', 'https://github.com/acme/app/blob/main/docs/adr/0004.md');
    const newer = adr('Supersedes the REST rule in CLAUDE.md.', 'ADR 0008: gRPC', 'https://github.com/acme/app/blob/main/docs/adr/0008.md');
    const last = { source_url: 'https://github.com/acme/app/blob/main/docs/adr/0010.md', title: 'ADR 0010', raw_text: 'Unrelated.' };
    const [oldId, newId, rowId, lastId] = await ingest(c, older, newer, claude(), last);
    applyJudgement({ dbPath, judge: me, origin: { via: 'cli' } }, how === 'replaced' ? { action: 'replaces', newer: lastId!, older: newId! } : { action: 'not-a-decision', id: newId! });
    const res = await c.checkAlignment('app.get("/users", handler)', undefined, { depth: 'related' });
    const ids = res.relevant_decisions.map((d) => d.id);
    expect(ids).toContain(oldId);
    expect(ids).not.toContain(newId);
    expect(res.relevant_decisions.find((d) => d.id === rowId)!.partly_replaced_by).toEqual([{ id: oldId, title: 'ADR 0004: GraphQL' }]);
  });
});

describe('13. ingest does not rescan the docs rows when nothing says "supersede"', () => {
  const scans = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((a) => String(a[0]).includes("source_url IS NOT NULL")).length;

  it('five plain rows trigger no docs scan', async () => {
    const c = client();
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare');
    await ingest(c, ...[1, 2, 3, 4, 5].map((n) => dated(`Row${n}`, `- Rule number ${n}.`)));
    const n = scans(spy);
    spy.mockRestore();
    expect(n).toBe(0);
  });

  it('control: a row with the sentence does scan', async () => {
    const c = client();
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare');
    await ingest(c, note('Supersedes the REST rule in CLAUDE.md.'));
    const n = scans(spy);
    spy.mockRestore();
    expect(n).toBeGreaterThan(0);
  });
});

describe('14. only a clause that starts with the verb counts', () => {
  it.each([
    'ADR 2 said "Supersedes the REST rule in CLAUDE.md" but never applied it.',
    'ADR 2 says it supersedes the logging rule in CLAUDE.md, which we now reverse.',
    'Previously, ADR 3 Supersedes the logging rule in CLAUDE.md.',
    '> Supersedes the REST rule in CLAUDE.md.',
    '\n```\nSupersedes the REST rule in CLAUDE.md.\n```',
    'It does not supersedes the REST rule in CLAUDE.md.',
    'Supersedes the REST rule in CLAUDE.md, but not the logging rule.',
    'We said \u201cSupersedes the REST rule in CLAUDE.md\u201d once.',
    'Supersedes the REST rule in CLAUDE.md no longer.',
  ])('%s links nothing', async (text) => {
    const c = client();
    await ingest(c, note(text), dated('Rules', '- Use REST routes and logging.'));
    expect(storedLinks()).toBe(0);
  });

  it.each([
    '- Supersedes the REST rule in CLAUDE.md.',
    'This ADR supersedes the REST rule in CLAUDE.md.',
    '1. Supersedes the REST rule in CLAUDE.md',
  ])('%s still links', async (text) => {
    const c = client();
    await ingest(c, note(text), dated('Rules', '- Use REST routes.'));
    expect(storedLinks()).toBe(1);
  });
});

describe('15. the common ADR header styles', () => {
  it.each([
    'Supersedes: the REST rule in CLAUDE.md',
    '- **Supersedes** the REST rule in CLAUDE.md',
    '**Supersedes:** the REST rule in CLAUDE.md',
    'Supersedes the REST rule in the CLAUDE.md file.',
    'Supersedes the REST rule in claude.md.',
    'Supersedes ADR 0002 and the REST rule in CLAUDE.md.',
  ])('%s', async (text) => {
    const c = client();
    await ingest(c, note(text), dated('Rules', '- Use REST routes.'));
    expect(storedLinks()).toBe(1);
  });

  it.each([
    ['Supersedes the REST rule in CLAUDE.md and the logging rule in AGENTS.md.'],
    ['Supersedes the REST rule in CLAUDE.md, and the logging rule in AGENTS.md'],
  ])('%s gives two links', async (text) => {
    const c = client();
    await ingest(c, note(text), dated('Rules', '- Use REST routes.'), dated('Style', '- Keep logging structured.', 'AGENTS.md'));
    expect(storedLinks()).toBe(2);
  });
});

describe('16. the rows that hold most of the rule words win', () => {
  it.each([
    ['Supersedes the code style rule in CLAUDE.md.', 'Code style: tabs.', 'Review code weekly.'],
    ['Supersedes the REST route rule in CLAUDE.md.', 'REST route naming.', 'Use REST clients in tests.'],
  ])('%s', async (sentence, best, other) => {
    const c = client();
    const [hit, miss] = await ingest(c, dated('A', best), dated('B', other), note(sentence));
    expect(storedLinks()).toBe(1);
    expect(await partlyBy(c, hit!, 'use')).toHaveLength(1);
    expect(await partlyBy(c, miss!, 'use')).toBeUndefined();
  });

  it('rows tied on the best score all link', async () => {
    const c = client();
    await ingest(c, dated('A', 'Code style: tabs.'), dated('B', 'Code style: spaces.'), note('Supersedes the code style rule in CLAUDE.md.'));
    expect(storedLinks()).toBe(2);
  });
});

describe('17. a deleted row re-resolves the ADRs naming its file', () => {
  it.each([
    ['Supersedes the REST rule in CLAUDE.md.', '- Use REST routes.', '- Use moment.'],
    ['Supersedes the Jest rule in CLAUDE.md.', '- Use Jest.', '- Use dayjs.'],
  ])('%s', async (sentence, wanted, other) => {
    const c = client();
    const [matching, fallback] = await ingest(c, dated('B', wanted), dated('A', other), note(sentence));
    expect(await partlyBy(c, matching!, 'use')).toHaveLength(1);
    c.close();
    opened.pop();
    const raw = new DatabaseSync(dbPath);
    deleteDecisionWithDependents(raw, matching!);
    raw.close();
    const again = client();
    expect(await partlyBy(again, fallback!, 'use')).toHaveLength(1); // now the file's only row
  });
});
