import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/similarity/embedding-matrix.js', async () =>
  (await import('./helpers/mocked-cosine-matrix.js')).mockedCosineMatrixModule());
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.75),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));
vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn(),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'refines', 'implements', 'depends_on', 'relates_to'],
}));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { classifyRelationship } from '../lib/local-relationship-classifier.js';
import { applyJudgement, contextKeyFor, filesFromDiff } from '../lib/curation/mark.js';
import { runMarkTool } from '../lib/mcp/mark-tool.js';
import { type MarkCommandDeps, runMarkCommand } from '../commands/mark.js';
import { lastCheckFor, readLastCheck, writeLastCheck } from '../lib/curation/last-check.js';
import { hasUnsafeChars, quote } from '../lib/curation/text.js';
import { listJudgements } from '../lib/curation/judgements-db.js';
import { shellFiles } from '../lib/curation/guardrail.js';

/**
 * LM round 3 Test List (re-review N2-N10):
 * - N2: every --undo (and --force) needs a terminal; undoing a person's verdict leaves a tombstone, so an agent still cannot
 *   write on that key until a person re-marks it; the tombstone hides nothing, lists nowhere, and is replaced by a re-mark.
 * - N3: a path with a control character has no key (nothing is hidden), is not offered as a file set, and prints escaped.
 * - N4: invisible and format characters (tags, zero-width, LRM/RLM, ALM, BOM, word joiner, variation selectors, annotation marks, lone
 *   surrogates, and the emoji joiner) are refused in notes; ordinary text and single-codepoint emoji are fine; quote() escapes them.
 * - N5: a symlinked last-check.json is not read; a default from another git HEAD is refused.
 * - N6: a classifier's replaceLink does not take away a mark-owned supersedes link, so --undo still removes it.
 * - Honesty: a banner only when an agent's mark APPLIED to this check; no annotation on a set with no key; ask says "answer".
 */
let dir: string;
let dbPath: string;
let client: ReturnType<typeof createLocalGatewayClient>;
let a: string;
let b: string;
const me = { judgeId: 'me', judgeLabel: null };
const diffOf = (...f: string[]) => f.map((x) => `diff --git a/${x} b/${x}\n--- a/${x}\n+++ b/${x}\n@@ -1 +1 @@\n-a\n+b\n`).join('');
const rows = (sql: string) => { const d = new DatabaseSync(dbPath); try { return d.prepare(sql).all() as Array<Record<string, unknown>>; } finally { d.close(); } };
const person = (m: Parameters<typeof applyJudgement>[1], opts: Parameters<typeof applyJudgement>[2] = {}) => applyJudgement({ dbPath, judge: me, origin: { via: 'cli' } }, m, opts);
const agent = (args: Record<string, unknown>) => runMarkTool(args, { mode: 'local-embedded', localDbPath: dbPath } as never, { clientInfo: { name: 'claude-code' }, judge: async () => me });
const hitIds = (r: Awaited<ReturnType<typeof client.checkAlignment>>) => (r.conflicts ?? []).map((c) => c.decision_id).sort();

function cli(args: string[], opts: Parameters<typeof runMarkCommand>[1], tty: boolean, over: Partial<MarkCommandDeps> = {}) {
  const out: string[] = [];
  return runMarkCommand(args, opts, { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`), graphPath: () => dbPath, judge: async () => me, lastCheck: () => null, isTty: () => tty, head: async () => null, ...over })
    .then((code) => ({ code, out: out.join(' | ') }));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-lm-r3-'));
  dbPath = path.join(dir, 'graph.db');
  client = createLocalGatewayClient(dbPath, { judgeId: 'me' });
  vi.mocked(classifyRelationship).mockResolvedValue({ ok: true, relationship: { type: 'conflicts_with', confidence: 0.9, reason: 'x' } } as never);
  a = (await client.captureDecision('Use Postgres for persistence', 'cli')).id;
  b = (await client.captureDecision('Use MySQL for the reporting store', 'cli')).id;
});
afterEach(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('N2 undo is a terminal act and leaves a tombstone', () => {
  it('every undo is refused without a terminal, and runs at one; --list never needs one', async () => {
    person({ action: 'check', id: a, verdict: 'real', files: ['x.ts'] });
    person({ action: 'conflict', a, b, verdict: 'real' });
    for (const [args, opts] of [
      [['check', a, 'real'], { files: ['x.ts'], undo: true }],
      [['conflict', a, b, 'real'], { undo: true }],
      [[a, 'not-a-decision'], { undo: true }],
      [[a, 'replaces', b], { undo: true }],
    ] as const) {
      const r = await cli([...args], opts, false);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.out).toMatch(/terminal/);
    }
    expect(rows('SELECT * FROM local_judgements')).toHaveLength(2);
    expect((await cli([], { list: true }, false)).code).toBe(0);
    expect((await cli(['check', a, 'real'], { files: ['x.ts'], undo: true }, true)).code).toBe(0);
  });

  it('after the person undoes a real verdict an agent still cannot write on that key (check, then pair)', async () => {
    person({ action: 'check', id: a, verdict: 'real', files: ['src/db.ts'] });
    person({ action: 'conflict', a, b, verdict: 'real' });
    await cli(['check', a, 'real'], { files: ['src/db.ts'], undo: true }, true);
    await cli(['conflict', a, b, 'real'], { undo: true }, true);
    await expect(agent({ decision_id: a, verdict: 'false', check_files: ['src/db.ts'] })).rejects.toThrow(/marked this yourself/);
    await expect(agent({ decision_id: a, verdict: 'real', check_files: ['src/db.ts'] })).rejects.toThrow(/marked this yourself/);
    await expect(agent({ decision_id: b, counterpart_id: a, verdict: 'false' })).rejects.toThrow(/marked this yourself/);
    expect(rows(`SELECT value FROM local_judgements WHERE via = 'mcp'`)).toEqual([]);
    expect(hitIds(await client.checkAlignment(diffOf('src/db.ts')))).toEqual([a, b].sort());
  });

  it('the tombstone hides nothing, is not listed, and is not a verdict anywhere', async () => {
    person({ action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
    expect(hitIds(await client.checkAlignment(diffOf('x.ts')))).toEqual([b]);
    await cli(['check', a, 'false'], { files: ['x.ts'], undo: true }, true);
    expect(hitIds(await client.checkAlignment(diffOf('x.ts')))).toEqual([a, b].sort());
    expect(listJudgements(dbPath, 'me')).toEqual([]);
    expect((await cli([], { list: true }, true)).out).toMatch(/No marks yet/);
    const again = await cli(['check', a, 'false'], { files: ['x.ts'], undo: true }, true);
    expect(again.out).toMatch(/no verdict/i);
  });

  it('a person re-marking replaces the tombstone, after which the key is the person\'s again', async () => {
    person({ action: 'check', id: a, verdict: 'real', files: ['x.ts'] });
    await cli(['check', a, 'real'], { files: ['x.ts'], undo: true }, true);
    const out = person({ action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
    expect(out.replaced).toBe(false);
    expect(rows('SELECT value, via FROM local_judgements')).toEqual([{ value: 'false', via: 'cli' }]);
  });

  it('undoing an AGENT\'s mark deletes it outright (no person ever marked that key), so an agent may write there again', async () => {
    await agent({ decision_id: a, verdict: 'false', check_files: ['x.ts'] });
    await cli(['check', a, 'false'], { files: ['x.ts'], undo: true }, true);
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
    await agent({ decision_id: a, verdict: 'real', check_files: ['x.ts'] });
    expect(rows('SELECT value FROM local_judgements')).toEqual([{ value: 'real' }]);
  });

  it('not-a-decision and replaces undo still delete the row (an agent cannot write those at all)', async () => {
    person({ action: 'not-a-decision', id: a });
    await cli([a, 'not-a-decision'], { undo: true }, true);
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
  });
});

describe('N3 control characters in file paths', () => {
  const esc = 'x\u001b[2J\u001b[8m.ts';
  const quoted = 'diff --git "a/x\\033[2J\\033[8m.ts" "b/x\\033[2J\\033[8m.ts"\n--- "a/x\\033[2J\\033[8m.ts"\n+++ "b/x\\033[2J\\033[8m.ts"\n@@ -1 +1 @@\n-a\n+b\n';
  it('a set holding such a path has no key', () => {
    expect(filesFromDiff(quoted)).toEqual([esc]);
    expect(contextKeyFor([esc])).toBeNull();
    expect(contextKeyFor(['ok.ts', esc])).toBeNull();
    expect(contextKeyFor(['ok.ts'])).not.toBeNull();
  });
  it('check_files with one is refused by the tool and by the command, naming nothing raw', async () => {
    await expect(agent({ decision_id: a, verdict: 'false', check_files: [esc] })).rejects.toThrow(/control characters/);
    const r = await cli(['check', a, 'false'], { files: [esc] }, true);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain('\u001b');
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
  });
  it('a check over such a path hides nothing, offers no file list, and says so once', async () => {
    const r = await client.checkAlignment(quoted);
    expect(hitIds(r)).toEqual([a, b].sort());
    expect(r.checked_files).toBeUndefined();
    expect((r.notes ?? []).filter((n) => /control characters/.test(n))).toHaveLength(1);
    expect((r.notes ?? []).join('')).not.toContain('\u001b');
  });
  it('shellFiles never emits a raw control byte', () => {
    expect(shellFiles(['a.ts', esc])).not.toContain('\u001b');
    expect(shellFiles(['a.ts', 'my file.ts'])).toBe("a.ts 'my file.ts'");
  });
});

describe('N4 invisible and format characters', () => {
  const cp = (...n: number[]) => String.fromCodePoint(...n);
  const bad: Array<[string, string]> = [
    ['tag', `ok ${cp(0xe0049, 0xe0047, 0xe004e)}`], ['zero-width space', `a${cp(0x200b)}b`], ['LRM', `a${cp(0x200e)}b`], ['RLM', `a${cp(0x200f)}b`],
    ['ALM', `a${cp(0x61c)}b`], ['BOM', `a${cp(0xfeff)}b`], ['word joiner', `a${cp(0x2060)}b`], ['variation selector', `a${cp(0xfe0f)}b`],
    ['interlinear annotation', `a${cp(0xfff9)}b`], ['NEL', `a${cp(0x85)}b`], ['emoji joiner', `${cp(0x1f469, 0x200d, 0x1f4bb)}`], ['lone surrogate', `a${String.fromCharCode(0xd800)}b`],
    ['private use', `a${cp(0xe000)}b`], ['line separator', `a${cp(0x2028)}b`], ['paragraph separator', `a${cp(0x2029)}b`],
  ];
  it.each(bad)('refuses %s in a note', (_n, text) => {
    expect(hasUnsafeChars(text)).toBe(true);
    expect(() => person({ action: 'note', id: a, text })).toThrow(/control characters|invisible/i);
  });
  it('allows ordinary text, accents, CJK and a single-codepoint emoji', () => {
    for (const t of ['café kept', '日本語', 'ship it \u{1f680}', 'a – b', 'non breaking']) expect(hasUnsafeChars(t), t).toBe(false);
    expect(() => person({ action: 'note', id: a, text: 'ship it \u{1f680}' })).not.toThrow();
  });
  it('quote escapes astral and format characters so they display as visible text', () => {
    expect(quote(`x${cp(0xe0049)}y`)).toBe('"x\\u{e0049}y"');
    expect(quote(`x${cp(0x200b)}y`)).toBe('"x\\u200by"');
    expect(quote('plain')).toBe('"plain"');
  });
});

describe('N5 last-check.json', () => {
  it.skipIf(process.platform === 'win32')('a symlink is not read', () => {
    const target = path.join(dir, 'planted.json');
    fs.writeFileSync(target, JSON.stringify({ checked_at: 'x', cwd: process.cwd(), files: ['chosen.ts'], decision_ids: ['ID'] }));
    const link = path.join(dir, 'lc.json');
    fs.symlinkSync(target, link);
    expect(readLastCheck(link)).toBeNull();
    expect(readLastCheck(target)?.files).toEqual(['chosen.ts']);
  });
  it('lastCheckFor records the git HEAD it ran at', () => {
    expect(lastCheckFor('', {}, new Date(0), '/w', 'abc123').head).toBe('abc123');
    expect(lastCheckFor('', {}, new Date(0), '/w', null).head).toBeNull();
    writeLastCheck({ checked_at: 't', cwd: '/w', head: 'abc123', files: ['a.ts'], decision_ids: ['d'] }, path.join(dir, 'x.json'));
    expect(readLastCheck(path.join(dir, 'x.json'))?.head).toBe('abc123');
  });
  it('a default from another HEAD is refused, the same HEAD is used', async () => {
    const lc = { files: ['x.ts'], decision_ids: [a], cwd: process.cwd(), head: 'aaa' };
    expect((await cli(['check', a, 'real'], {}, true, { lastCheck: () => lc, head: async () => 'bbb' })).code).toBe(2);
    expect((await cli(['check', a, 'real'], {}, true, { lastCheck: () => lc, head: async () => 'aaa' })).code).toBe(0);
    expect(rows('SELECT * FROM local_judgements')).toHaveLength(1);
  });
});

describe('N6 a classifier edge does not take a person\'s link', () => {
  it('replaceLink leaves a mark-owned link, and --undo still removes it', async () => {
    person({ action: 'replaces', newer: b, older: a });
    const l = createLocalDb(dbPath);
    l.replaceLink({ sourceId: b, targetId: a, relation: 'supersedes', confidence: 0.8 });
    l.replaceLink({ sourceId: a, targetId: b, relation: 'relates', confidence: 0.6 });
    l.close();
    expect(rows(`SELECT id FROM decision_links WHERE relation = 'supersedes'`).map((r) => String(r['id']).startsWith('mark:'))).toEqual([true]);
    const u = person({ action: 'replaces', newer: b, older: a }, { undo: true });
    expect(u.text).toMatch(/supersedes link it created/);
    expect(rows(`SELECT id FROM decision_links WHERE relation = 'supersedes'`)).toEqual([]);
  });
  it('replaceLink still replaces every other edge between a pair (the capture-time upgrade is unchanged)', () => {
    const l = createLocalDb(dbPath);
    l.insertLink({ sourceId: a, targetId: b, relation: 'relates', confidence: 0.5 });
    l.replaceLink({ sourceId: a, targetId: b, relation: 'conflicts_with', confidence: 0.9 });
    l.close();
    expect(rows('SELECT relation FROM decision_links')).toEqual([{ relation: 'conflicts_with' }]);
  });
  it('plain undo restores the older decision as active (N10)', async () => {
    person({ action: 'replaces', newer: b, older: a });
    expect((await client.listDecisions({ status: 'active', all: true })).some((d) => d.id === a)).toBe(false);
    person({ action: 'replaces', newer: b, older: a }, { undo: true });
    expect((await client.listDecisions({ status: 'active', all: true })).some((d) => d.id === a)).toBe(true);
  });
});

describe('honesty in what a check says', () => {
  const agentFalse = (id: string, files: string[]) => applyJudgement({ dbPath, judge: me, origin: { via: 'mcp', agentId: 'claude-code' } }, { action: 'check', id, verdict: 'false', files });
  it('the banner appears only when an agent\'s mark applied to THIS check', async () => {
    agentFalse(a, ['x.ts']);
    const elsewhere = await client.checkAlignment(diffOf('z.ts'));
    expect((elsewhere.notes ?? []).join('\n')).not.toMatch(/by agents/);
    const here = await client.checkAlignment(diffOf('x.ts'));
    expect(here.notes?.[0]).toMatch(/^1 mark by agents since \d{4}-\d{2}-\d{2} affects this check \(align mark --list\)$/);
  });
  it('a person\'s own marks (a left-out decision, a replacement) never bring the agent banner', async () => {
    person({ action: 'not-a-decision', id: a });
    person({ action: 'replaces', newer: a, older: b });
    const r = await client.checkAlignment(diffOf('x.ts'));
    expect(r.notes?.length).toBeGreaterThan(0);
    expect((r.notes ?? []).join('\n')).not.toMatch(/by agents/);
  });
  it('a tombstone for this file set does not stop the note about a false alarm given for another set', async () => {
    person({ action: 'check', id: a, verdict: 'false', files: ['y.ts'] });
    person({ action: 'check', id: a, verdict: 'real', files: ['x.ts'] });
    await cli(['check', a, 'real'], { files: ['x.ts'], undo: true }, true);
    expect((await client.checkAlignment(diffOf('x.ts'))).notes?.join('\n')).toContain('false alarm once');
  });
  it('a check that found nothing carries no banner for a mark that hid nothing', async () => {
    agentFalse(a, ['x.ts']);
    vi.mocked((await import('../lib/local-embeddings.js')).cosineSimilarity).mockReturnValue(0);
    const r = await client.checkAlignment(diffOf('x.ts'));
    expect(r.notes).toBeUndefined();
    vi.mocked((await import('../lib/local-embeddings.js')).cosineSimilarity).mockReturnValue(0.75);
  });
  it('an older agent not-a-decision row counts only when that decision was actually left out', async () => {
    const d = new DatabaseSync(dbPath);
    d.prepare(`INSERT INTO local_judgements (id, decision_id, kind, judge_id, via, agent_id, judged_at) VALUES ('l1', ?, 'not_a_decision', 'me', 'mcp', 'claude-code', '2026-10-01T00:00:00.000Z')`).run(a);
    d.close();
    const r = await client.checkAlignment(diffOf('x.ts'));
    expect(r.notes?.[0]).toMatch(/^1 mark by agents since 2026-10-01 affects this check/);
  });
  it('no annotation, and no false claim, on a set with no key (more than 500 files)', async () => {
    person({ action: 'check', id: a, verdict: 'false', files: ['x.ts'] });
    const many = Array.from({ length: 501 }, (_, i) => `f/${i}.ts`);
    const r = await client.checkAlignment(diffOf(...many));
    expect(hitIds(r)).toEqual([a, b].sort());
    expect((r.notes ?? []).join('\n')).not.toContain('false alarm once');
    expect((r.notes ?? []).join('\n')).toContain('no file-set mark can hide or annotate anything in it');
  });
  it('ask says a decision was left out of the ANSWER, not the check', async () => {
    person({ action: 'not-a-decision', id: a });
    const r = await client.searchDecisions('Postgres persistence', 5);
    expect(r.notes?.join('\n')).toContain('was left out of this answer');
    expect(r.notes?.join('\n')).not.toContain('left out of this check');
  });
});
