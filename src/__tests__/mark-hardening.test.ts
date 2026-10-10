import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';
import { applyJudgement, contextKeyFor, filesFromDiff, MarkError, MAX_CHECK_FILES, MAX_NOTE_CHARS, normaliseFiles } from '../lib/curation/mark.js';
import { quote } from '../lib/curation/text.js';
import { lastCheckFor, readLastCheck, writeLastCheck } from '../lib/curation/last-check.js';
import { type MarkCommandDeps, runMarkCommand } from '../commands/mark.js';

/**
 * LM hardening Test List (security review F1-F12):
 * - F4: more than 500 files has NO key (never a superset match); exactly 500 still does.
 * - F7: filesFromDiff reads +++ lines and quoted C-style paths; a path holding " b/" is not cut; hunk content never counts.
 * - F5/F12: a note with a control character, newline, ESC, DEL, C1 or bidi override is refused at the write; plain unicode is fine; 500 chars max.
 *   Existing rows holding control bytes are printed escaped by --list.
 * - F2/F3: `replaces` records the link under the judgement's id, --undo deletes exactly that link, a link the classifier made stays,
 *   a ratified/confirmed target is refused without --force at a terminal, and an agent cannot write one at all.
 * - F10: last-check.json is written by temp file then rename, 0600, and never through a symlink or onto a non-file.
 * - F6: last-check carries cwd and every retrieved decision id; a default whose set does not belong to the marked decision is refused.
 * - Suppressive CLI marks need a terminal; undo and `real` do not.
 */
// Written as code points so the file carries no invisible characters itself.
const BIDI = String.fromCharCode(0x202e);
const LS = String.fromCharCode(0x2028);
let dir: string;
let dbPath: string;
let ids: Record<string, string>;
const me = { judgeId: 'inst-me', judgeLabel: null };
const rows = (sql: string) => { const d = new DatabaseSync(dbPath); try { return d.prepare(sql).all() as Array<Record<string, unknown>>; } finally { d.close(); } };
const person = (m: Parameters<typeof applyJudgement>[1], opts: Parameters<typeof applyJudgement>[2] = {}) =>
  applyJudgement({ dbPath, judge: me, origin: { via: 'cli' } }, m, opts);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-lm-hard-'));
  dbPath = path.join(dir, 'graph.db');
  const db = createLocalDb(dbPath);
  ids = {};
  for (const t of ['alpha', 'bravo']) ids[t] = db.insertDecision({ title: `${t} decision`, summary: t, sourceUrl: `https://example.com/${t}`, platform: 'cli' });
  db.close();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('F4 the file cap never makes a superset match', () => {
  const files = (n: number, p = 'a') => Array.from({ length: n }, (_, i) => `${p}/${String(i).padStart(4, '0')}.ts`);
  it('exactly 500 files has a key; 501 has none; the list is never cut', () => {
    expect(MAX_CHECK_FILES).toBe(500);
    expect(contextKeyFor(files(500))).toMatch(/^[0-9a-f]{64}$/);
    expect(contextKeyFor(files(501))).toBeNull();
    expect(normaliseFiles(files(501))).toHaveLength(501);
    expect(contextKeyFor([...files(500), ...files(100, 'z')])).not.toBe(contextKeyFor(files(500)));
  });
  it('a check mark over 501 files is a usage error, stored nowhere', () => {
    expect(() => person({ action: 'check', id: ids.alpha, verdict: 'false', files: files(501) })).toThrow(MarkError);
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
  });
});

describe('F7 filesFromDiff', () => {
  it('reads the +++ line, so a path containing " b/" is not cut', () => {
    const d = 'diff --git a/x b/c.ts b/x b/c.ts\n--- a/x b/c.ts\n+++ b/x b/c.ts\n@@ -1 +1 @@\n-a\n+b\n';
    expect(filesFromDiff(d)).toEqual(['x b/c.ts']);
  });
  it('unquotes C-style quoted paths (space, non-ASCII bytes, escaped quote)', () => {
    expect(filesFromDiff('diff --git "a/x y.ts" "b/x y.ts"\n--- "a/x y.ts"\n+++ "b/x y.ts"\n')).toEqual(['x y.ts']);
    expect(filesFromDiff('diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n')).toEqual(['café.ts']);
    expect(filesFromDiff('diff --git "a/q\\"x.ts" "b/q\\"x.ts"\n+++ "b/q\\"x.ts"\n')).toEqual(['q"x.ts']);
  });
  it('a deleted file is named by its --- line, a rename by "rename to", a mode change by its symmetric header', () => {
    expect(filesFromDiff('diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n')).toEqual(['gone.ts']);
    expect(filesFromDiff('diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n')).toEqual(['new.ts']);
    expect(filesFromDiff('diff --git a/m.sh b/m.sh\nold mode 100644\nnew mode 100755\n')).toEqual(['m.sh']);
  });
  it('an added line that looks like a +++ header inside a hunk is content, not a file', () => {
    const d = 'diff --git a/real.ts b/real.ts\n--- a/real.ts\n+++ b/real.ts\n@@ -1 +1,2 @@\n a\n+++ b/forged.ts\n';
    expect(filesFromDiff(d)).toEqual(['real.ts']);
  });
  it('prose is no files', () => {
    expect(filesFromDiff('just words, no diff')).toEqual([]);
  });
});

describe('F5/F12 notes cannot carry control characters', () => {
  const note = (text: string) => () => person({ action: 'note', id: ids.alpha, text });
  it('refuses newline, ESC, BEL, NUL, DEL, a C1 control and a bidi override (each one)', () => {
    for (const bad of ['a\nb', 'a\u001b[2Jb', 'a\u0007b', 'a\u0000b', 'a\u007fb', 'a\u009bb', `a${BIDI}b`, `a${LS}b`, 'a\tb']) {
      expect(note(bad), JSON.stringify(bad)).toThrow(/control character/i);
    }
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
  });
  it('allows ordinary unicode and punctuation', () => {
    expect(note('café ✓ kept for SOC2 (日本語)')).not.toThrow();
    expect(rows('SELECT note FROM local_judgements')).toHaveLength(1);
  });
  it('is capped at 500 characters, on both sides of the boundary', () => {
    expect(MAX_NOTE_CHARS).toBe(500);
    expect(note('x'.repeat(500))).not.toThrow();
    expect(note('x'.repeat(501))).toThrow(/at most 500/);
  });
  it('--list prints a stored note (or title) with control bytes escaped, one row per mark', async () => {
    const d = new DatabaseSync(dbPath);
    d.prepare(`INSERT INTO local_judgements (id, decision_id, kind, note, judge_id, via, agent_id, judged_at) VALUES ('n1', ?, 'note', ?, 'inst-me', 'mcp', 'claude-code', '2026-10-10T00:00:00.000Z')`)
      .run(ids.alpha, 'fine\n2026-10-10  not a decision  (by you)\u001b[8m\u009b2J');
    d.close();
    const out: string[] = [];
    await runMarkCommand([], { list: true }, { out: (l) => out.push(l), err: (l) => out.push(l), graphPath: () => dbPath, judge: async () => me, lastCheck: () => null, isTty: () => true });
    expect(out).toHaveLength(1);
    expect([...out[0]].some((c) => { const n = c.charCodeAt(0); return n < 0x20 || (n >= 0x7f && n <= 0x9f); })).toBe(false);
    expect(out[0]).toContain('\\u001b[8m');
    expect(out[0]).toContain('by claude-code via MCP');
  });
  it('quote escapes C0, C1, line separators and bidi overrides, and keeps ordinary text readable', () => {
    expect(quote('a"b')).toBe('"a\\"b"');
    expect(quote('café')).toBe('"café"');
    expect(quote(`x\u009by${BIDI}z${LS}`)).toBe('"x\\u009by\\u202ez\\u2028"');
    expect(quote('\u001b[0m')).toBe('"\\u001b[0m"');
  });
});

describe('F2/F3 replaces is owned, undoable, and not casual', () => {
  const links = () => rows(`SELECT id, source_id, target_id FROM decision_links WHERE relation = 'supersedes'`);
  it('--undo deletes the link the mark created, and nothing else', () => {
    const db = createLocalDb(dbPath);
    const c = db.insertDecision({ title: 'charlie', summary: 'c', sourceUrl: 'https://example.com/c', platform: 'cli' });
    db.insertLink({ sourceId: ids.bravo, targetId: c, relation: 'supersedes', confidence: 0.7 });
    db.close();
    person({ action: 'replaces', newer: ids.alpha, older: ids.bravo });
    expect(links()).toHaveLength(2);
    const out = person({ action: 'replaces', newer: ids.alpha, older: ids.bravo }, { undo: true });
    expect(out.undone).toBe(true);
    expect(links().map((l) => [l.source_id, l.target_id])).toEqual([[ids.bravo, c]]);
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
  });
  it('re-marking keeps one link and one judgement, and undo still removes it', () => {
    person({ action: 'replaces', newer: ids.alpha, older: ids.bravo });
    person({ action: 'replaces', newer: ids.alpha, older: ids.bravo });
    expect(links()).toHaveLength(1);
    person({ action: 'replaces', newer: ids.alpha, older: ids.bravo }, { undo: true });
    expect(links()).toEqual([]);
  });
  it('a link the classifier made first is not ours: undo removes the judgement and leaves the link', () => {
    const db = createLocalDb(dbPath);
    db.insertLink({ sourceId: ids.alpha, targetId: ids.bravo, relation: 'supersedes', confidence: 0.9 });
    db.close();
    person({ action: 'replaces', newer: ids.alpha, older: ids.bravo });
    person({ action: 'replaces', newer: ids.alpha, older: ids.bravo }, { undo: true });
    expect(links()).toHaveLength(1);
  });
  it('the only link delete is restricted to a judgement\'s own link', () => {
    const db = createLocalDb(dbPath);
    db.insertLink({ sourceId: ids.alpha, targetId: ids.bravo, relation: 'supersedes', confidence: 0.9 });
    expect(db.deleteMarkLink('not-a-judgement-id')).toBe(0);
    db.close();
    expect(links()).toHaveLength(1);
  });
  it('refuses a ratified or confirmed target without force, allows it with force', () => {
    const db = createLocalDb(dbPath);
    db.markRatified(ids.bravo, 'tom');
    db.close();
    expect(() => person({ action: 'replaces', newer: ids.alpha, older: ids.bravo })).toThrow(/ratified/);
    expect(links()).toEqual([]);
    person({ action: 'replaces', newer: ids.alpha, older: ids.bravo }, { force: true });
    expect(links()).toHaveLength(1);
    const db2 = createLocalDb(dbPath);
    const c = db2.insertDecision({ title: 'conf', summary: 'c', sourceUrl: 'https://example.com/conf', platform: 'cli' });
    db2.markConfirmed(c, 'tom');
    db2.close();
    expect(() => person({ action: 'replaces', newer: ids.alpha, older: c })).toThrow(/confirmed/);
  });
  it('an agent cannot replace or exclude: refused with the person\'s command, nothing stored', () => {
    const agent = { dbPath, judge: me, origin: { via: 'mcp' as const, agentId: 'claude-code' } };
    expect(() => applyJudgement(agent, { action: 'replaces', newer: ids.alpha, older: ids.bravo })).toThrow(`align mark ${ids.alpha} replaces ${ids.bravo}`);
    expect(() => applyJudgement(agent, { action: 'not-a-decision', id: ids.alpha })).toThrow(`align mark ${ids.alpha} not-a-decision`);
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
    expect(links()).toEqual([]);
  });
});

describe('F10 last-check.json', () => {
  it('writes through a temp file and replaces, 0600, leaving no temp behind', () => {
    const f = path.join(dir, 'last-check.json');
    fs.writeFileSync(f, '{}', { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    writeLastCheck({ checked_at: 't', files: ['a'], decision_ids: [], cwd: '/x' }, f);
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o077).toBe(0);
    expect(readLastCheck(f)?.files).toEqual(['a']);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('never writes through a symlink or onto a non-file', () => {
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'precious');
    const link = path.join(dir, 'lc-link.json');
    fs.symlinkSync(victim, link);
    writeLastCheck({ checked_at: 't', files: ['a'], decision_ids: [], cwd: '/x' }, link);
    expect(fs.readFileSync(victim, 'utf8')).toBe('precious');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const asDir = path.join(dir, 'lc-dir.json');
    fs.mkdirSync(asDir);
    expect(() => writeLastCheck({ checked_at: 't', files: [], decision_ids: [], cwd: '/x' }, asDir)).not.toThrow();
    expect(fs.statSync(asDir).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('F6 the default file set must belong to the decision being marked', () => {
  const baseDeps = (over: Partial<MarkCommandDeps> = {}): MarkCommandDeps & { out: string[]; err: string[] } => {
    const out: string[] = []; const err: string[] = [];
    return { out: (l) => out.push(l), err: (l) => err.push(l), graphPath: () => dbPath, judge: async () => me, lastCheck: () => null, isTty: () => true, ...over, outBuf: out, errBuf: err } as never;
  };
  it('lastCheckFor keeps cwd and every retrieved decision id, hidden hits included, and never the diff', () => {
    const e = lastCheckFor('diff --git a/a.ts b/a.ts\n+++ b/a.ts\n', { relevant_decisions: [{ id: 'd1' }, { id: 'd2' }], conflicts: [{ decision_id: 'd3' }] }, new Date(0), '/work/repo');
    expect(e).toMatchObject({ cwd: '/work/repo', files: ['a.ts'] });
    expect(e.decision_ids.sort()).toEqual(['d1', 'd2', 'd3']);
  });
  it('uses the last check only when it covered this decision in this directory', async () => {
    const lc = { files: ['src/db.ts'], decision_ids: [ids.alpha], cwd: process.cwd() };
    const ok = baseDeps({ lastCheck: () => lc });
    expect(await runMarkCommand(['check', ids.alpha, 'real'], {}, ok)).toBe(0);
    const other = baseDeps({ lastCheck: () => lc });
    expect(await runMarkCommand(['check', ids.bravo, 'real'], {}, other)).toBe(2);
    expect((other as never as { errBuf: string[] }).errBuf.join(' ')).toMatch(/did not cover|--files/);
    const elsewhere = baseDeps({ lastCheck: () => ({ ...lc, cwd: path.join(dir, 'another-repo') }) });
    expect(await runMarkCommand(['check', ids.alpha, 'real'], {}, elsewhere)).toBe(2);
    expect(rows('SELECT decision_id FROM local_judgements')).toEqual([{ decision_id: ids.alpha }]);
  });
  it('an old last-check.json without decision_ids is not a default', async () => {
    expect(await runMarkCommand(['check', ids.alpha, 'real'], {}, baseDeps({ lastCheck: () => ({ files: ['x.ts'] }) as never }))).toBe(2);
  });
  it('the confirmation echoes the files the verdict covers', async () => {
    const d = baseDeps();
    await runMarkCommand(['check', ids.alpha, 'real'], { files: ['b.ts', 'a.ts'] }, d);
    expect((d as never as { outBuf: string[] }).outBuf.join(' ')).toContain('"a.ts", "b.ts"');
  });
});

describe('suppressive CLI marks need a terminal', () => {
  const run = (args: string[], opts: Parameters<typeof runMarkCommand>[1], tty: boolean) => {
    const err: string[] = [];
    return runMarkCommand(args, opts, { out: () => {}, err: (l) => err.push(l), graphPath: () => dbPath, judge: async () => me, lastCheck: () => null, isTty: () => tty })
      .then((code) => ({ code, err: err.join(' ') }));
  };
  it('check false, not-a-decision and replaces are refused without a terminal (exit 1, nothing stored)', async () => {
    for (const [args, opts] of [
      [['check', ids.alpha, 'false'], { files: ['x.ts'] }],
      [[ids.alpha, 'not-a-decision'], {}],
      [[ids.alpha, 'replaces', ids.bravo], {}],
    ] as const) {
      const r = await run([...args], opts, false);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toMatch(/terminal/);
    }
    expect(rows('SELECT * FROM local_judgements')).toEqual([]);
  });
  it('real verdicts, conflict marks, notes and every --undo still run without one; the same marks run at a terminal', async () => {
    expect((await run(['check', ids.alpha, 'real'], { files: ['x.ts'] }, false)).code).toBe(0);
    expect((await run(['conflict', ids.alpha, ids.bravo, 'false'], {}, false)).code).toBe(0);
    expect((await run([ids.alpha, 'note', 'n'], {}, false)).code).toBe(0);
    expect((await run([ids.alpha, 'not-a-decision'], { undo: true }, false)).code).toBe(0);
    expect((await run([ids.alpha, 'not-a-decision'], {}, true)).code).toBe(0);
    expect((await run(['check', ids.alpha, 'false'], { files: ['x.ts'] }, true)).code).toBe(0);
  });
  it('--force needs a terminal too', async () => {
    const db = createLocalDb(dbPath);
    db.markRatified(ids.bravo, 'tom');
    db.close();
    expect((await run([ids.alpha, 'replaces', ids.bravo], { force: true }, false)).code).toBe(1);
    expect((await run([ids.alpha, 'replaces', ids.bravo], {}, true)).code).toBe(1);
    expect((await run([ids.alpha, 'replaces', ids.bravo], { force: true }, true)).code).toBe(0);
  });
});
