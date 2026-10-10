import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';
import { type MarkCommandDeps, runMarkCommand } from '../commands/mark.js';
import { contextKeyFor } from '../lib/curation/mark.js';

/**
 * LM Test List (`align mark`):
 * - conflict A B false: one cli row, agent NULL, this install's judge_id; B A is the same row; real replaces it; another judge's row survives.
 * - check A false --files: keyed on the sorted-path hash; files default to the last check's set; neither is exit 2.
 * - A replaces B: a supersede row and a supersedes link A -> B; A replaces A is exit 2.
 * - not-a-decision and --undo; note appends (two notes, two rows).
 * - an unknown id is exit 1 and named; no TTY is not a problem (a mark is a person's answer, not a gate).
 * - --list shows this judge's marks with who relayed them; --undo removes only this judge's row.
 * - every success line says it stayed on this machine.
 */
let dir: string;
let dbPath: string;
let out: string[];
let err: string[];
let ids: Record<string, string>;
let last: { files: string[] } | null;

const ME = { judgeId: 'inst-me', judgeLabel: 'me@example.com' };

function deps(over: Partial<MarkCommandDeps> = {}): MarkCommandDeps {
  return {
    out: (l) => out.push(l), err: (l) => err.push(l),
    graphPath: () => dbPath,
    judge: async () => ME,
    lastCheck: () => last,
    ...over,
  };
}
const run = (args: string[], opts: Parameters<typeof runMarkCommand>[1] = {}, over: Partial<MarkCommandDeps> = {}) => runMarkCommand(args, opts, deps(over));
const rows = (sql: string) => { const d = new DatabaseSync(dbPath); try { return d.prepare(sql).all() as Array<Record<string, unknown>>; } finally { d.close(); } };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-lm-mark-'));
  dbPath = path.join(dir, 'graph.db');
  const db = createLocalDb(dbPath);
  ids = {};
  for (const t of ['alpha', 'bravo', 'charlie']) ids[t] = db.insertDecision({ title: `${t} decision`, summary: t, sourceUrl: `https://example.com/${t}`, platform: 'cli' });
  db.close();
  out = []; err = []; last = null;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('align mark conflict', () => {
  it('stores one cli row for the pair, in either id order, with this install as judge and no agent', async () => {
    expect(await run(['conflict', ids.alpha, ids.bravo, 'false'])).toBe(0);
    expect(await run(['conflict', ids.bravo, ids.alpha, 'false'])).toBe(0);
    const [only, ...more] = rows('SELECT * FROM local_judgements');
    expect(more).toEqual([]);
    expect(only).toMatchObject({ kind: 'conflict_verdict', value: 'false', judge_id: 'inst-me', judge_label: 'me@example.com', via: 'cli', agent_id: null });
    const [lo, hi] = [ids.alpha, ids.bravo].sort();
    expect([only.decision_id, only.counterpart_id]).toEqual([lo, hi]);
  });

  it('a later real replaces this judge\'s answer and leaves another judge\'s row alone', async () => {
    await run(['conflict', ids.alpha, ids.bravo, 'false'], {}, { judge: async () => ({ judgeId: 'inst-other', judgeLabel: null }) });
    await run(['conflict', ids.alpha, ids.bravo, 'false']);
    await run(['conflict', ids.alpha, ids.bravo, 'real']);
    expect(rows('SELECT judge_id, value FROM local_judgements ORDER BY judge_id')).toEqual([
      { judge_id: 'inst-me', value: 'real' }, { judge_id: 'inst-other', value: 'false' },
    ]);
  });

  it('a verdict that is neither real nor false is exit 2 and stores nothing (two bad values)', async () => {
    expect(await run(['conflict', ids.alpha, ids.bravo, 'maybe'])).toBe(2);
    expect(await run(['conflict', ids.alpha, ids.bravo])).toBe(2);
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
    expect(err.join('\n')).toContain('align mark conflict <a> <b> real|false');
  });

  it('marking a decision against itself is exit 2', async () => {
    expect(await run(['conflict', ids.alpha, ids.alpha, 'false'])).toBe(2);
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
  });
});

describe('align mark check', () => {
  it('keys the verdict on the sorted-path hash, whatever order --files came in', async () => {
    expect(await run(['check', ids.alpha, 'false'], { files: ['y.ts', 'x.ts'] })).toBe(0);
    expect(rows('SELECT kind, value, context_key FROM local_judgements')).toEqual([
      { kind: 'check_verdict', value: 'false', context_key: contextKeyFor(['x.ts', 'y.ts']) },
    ]);
    expect(contextKeyFor(['x.ts', 'y.ts'])).toBe(contextKeyFor(['y.ts', 'x.ts', 'x.ts']));
    expect(contextKeyFor(['x.ts', 'y.ts'])).not.toBe(contextKeyFor(['x.ts', 'z.ts']));
  });

  it('uses the last check\'s files when --files is absent', async () => {
    last = { files: ['a/b.ts'] };
    expect(await run(['check', ids.alpha, 'real'])).toBe(0);
    expect(rows('SELECT context_key FROM local_judgements')).toEqual([{ context_key: contextKeyFor(['a/b.ts']) }]);
  });

  it('with no --files and no last check it is exit 2 and says how to give files', async () => {
    expect(await run(['check', ids.alpha, 'false'])).toBe(2);
    expect(err.join('\n')).toMatch(/--files/);
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
  });

  it('--files given wins over the last check\'s files', async () => {
    last = { files: ['old.ts'] };
    await run(['check', ids.alpha, 'false'], { files: ['new.ts'] });
    expect(rows('SELECT context_key FROM local_judgements')).toEqual([{ context_key: contextKeyFor(['new.ts']) }]);
  });
});

describe('align mark <a> replaces <b>', () => {
  it('writes a supersede judgement and a supersedes link a -> b, once however often it is said', async () => {
    expect(await run([ids.alpha, 'replaces', ids.bravo])).toBe(0);
    expect(await run([ids.alpha, 'replaces', ids.bravo])).toBe(0);
    expect(rows('SELECT kind, decision_id, counterpart_id FROM local_judgements')).toEqual([{ kind: 'supersede', decision_id: ids.alpha, counterpart_id: ids.bravo }]);
    expect(rows(`SELECT source_id, target_id, relation FROM decision_links WHERE relation = 'supersedes'`)).toEqual([{ source_id: ids.alpha, target_id: ids.bravo, relation: 'supersedes' }]);
  });
  it('a decision cannot replace itself: exit 2, nothing written', async () => {
    expect(await run([ids.alpha, 'replaces', ids.alpha])).toBe(2);
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
    expect(rows('SELECT * FROM decision_links')).toEqual([]);
  });
});

describe('not-a-decision and note', () => {
  it('not-a-decision stores one row and --undo deletes this judge\'s row only', async () => {
    await run([ids.alpha, 'not-a-decision']);
    await run([ids.alpha, 'not-a-decision'], {}, { judge: async () => ({ judgeId: 'inst-other', judgeLabel: null }) });
    expect(rows('SELECT judge_id FROM local_judgements ORDER BY judge_id')).toEqual([{ judge_id: 'inst-me' }, { judge_id: 'inst-other' }]);
    expect(await run([ids.alpha, 'not-a-decision'], { undo: true })).toBe(0);
    expect(rows('SELECT judge_id FROM local_judgements')).toEqual([{ judge_id: 'inst-other' }]);
  });
  it('notes append: two notes are two rows', async () => {
    await run([ids.alpha, 'note', 'kept for SOC2']);
    await run([ids.alpha, 'note', 'second thought']);
    expect(rows(`SELECT note FROM local_judgements WHERE kind = 'note' ORDER BY rowid`)).toEqual([{ note: 'kept for SOC2' }, { note: 'second thought' }]);
  });
  it('an empty or over-long note is exit 2', async () => {
    expect(await run([ids.alpha, 'note', '   '])).toBe(2);
    expect(await run([ids.alpha, 'note', 'x'.repeat(2001)])).toBe(2);
    expect(await run([ids.alpha, 'note', 'x'.repeat(2000)])).toBe(0);
  });
});

describe('ids, graph and output', () => {
  it('an unknown id is exit 1 and is named', async () => {
    expect(await run([ids.alpha, 'replaces', 'no-such-id'])).toBe(1);
    expect(err.join('\n')).toContain('no-such-id');
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
    expect(await run(['nope-either', 'note', 'x'])).toBe(1);
  });
  it('no local graph: says so, exit 1, and creates no file', async () => {
    const missing = path.join(dir, 'absent', 'graph.db');
    expect(await run([ids.alpha, 'note', 'x'], {}, { graphPath: () => missing })).toBe(1);
    expect(fs.existsSync(missing)).toBe(false);
    expect(await run([ids.alpha, 'note', 'x'], {}, { graphPath: () => undefined })).toBe(1);
  });
  it('every success says the mark stayed on this machine', async () => {
    await run([ids.alpha, 'note', 'a note']);
    await run(['conflict', ids.alpha, ids.bravo, 'false']);
    expect(out.filter((l) => /nothing was shared/i.test(l))).toHaveLength(2);
  });
});

describe('align mark --list', () => {
  it('shows this judge\'s marks with their titles and who relayed them, newest first', async () => {
    await run(['conflict', ids.alpha, ids.bravo, 'false']);
    // An agent-relayed row, written the way the MCP tool writes it.
    const d = new DatabaseSync(dbPath);
    d.prepare(`INSERT INTO local_judgements (id, decision_id, kind, judge_id, via, agent_id, judged_at) VALUES ('m1', ?, 'not_a_decision', 'inst-me', 'mcp', 'claude-code', '2999-01-01T00:00:00.000Z')`).run(ids.charlie);
    d.prepare(`INSERT INTO local_judgements (id, decision_id, counterpart_id, kind, value, judge_id, via, agent_id, judged_at) VALUES ('m2', ?, ?, 'conflict_verdict', 'false', 'inst-me', 'mcp', 'claude-code', '2998-01-01T00:00:00.000Z')`).run(...[ids.alpha, ids.charlie].sort());
    d.prepare(`INSERT INTO local_judgements (id, decision_id, kind, judge_id, via, judged_at) VALUES ('x1', ?, 'not_a_decision', 'inst-other', 'cli', '2999-02-01T00:00:00.000Z')`).run(ids.alpha);
    d.close();
    out = [];
    expect(await run([], { list: true })).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('charlie decision');
    expect(text).toContain('marked not a decision by claude-code via MCP');
    expect(text).toContain('marked false by claude-code via MCP');
    expect(text.indexOf('charlie decision')).toBeLessThan(text.indexOf('alpha decision'));
    expect(text).not.toContain('inst-other');
    expect(out.filter((l) => l.includes('not a decision'))).toHaveLength(1);
  });
  it('with an id, lists only the marks that name it; with none, says so', async () => {
    await run(['conflict', ids.alpha, ids.bravo, 'false']);
    out = [];
    await run([ids.charlie], { list: true });
    expect(out.join('\n')).toMatch(/no marks/i);
    out = [];
    await run([ids.bravo], { list: true });
    expect(out.join('\n')).toContain('false alarm');
  });
});

describe('align mark --undo', () => {
  it('removes this judge\'s conflict and check verdicts, and says when there was nothing to remove', async () => {
    await run(['conflict', ids.alpha, ids.bravo, 'false']);
    await run(['check', ids.alpha, 'false'], { files: ['x.ts'] });
    expect(await run(['conflict', ids.bravo, ids.alpha, 'false'], { undo: true })).toBe(0);
    expect(await run(['check', ids.alpha, 'false'], { files: ['x.ts'], undo: true })).toBe(0);
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
    out = [];
    await run(['conflict', ids.bravo, ids.alpha, 'false'], { undo: true });
    expect(out.join('\n')).toMatch(/no verdict/i);
  });
});
