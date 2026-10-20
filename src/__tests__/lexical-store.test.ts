import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';
import { deleteDecisionWithDependents } from '../lib/local-db-migrate.js';
import { createLexicalStore, LEXICAL_RECIPE } from '../lib/lexical-store.js';
import { queryTerms } from '../lib/lexical-terms.js';
import { rmDir } from './helpers/rm-dir.js';

const meta = '\n\nAuthor: A <a@b.c>\nDate: 2025-01-01\nFiles changed:\n- src/x.ts';
let dir: string;
let dbPath: string;
let db: ReturnType<typeof createLocalDb>;

let counter = 0;
function add(title: string, body: string, platform = 'git', n = ++counter): string {
  return db.insertDecision({ title, summary: `${title}\n\n${body}${meta}`, sourceUrl: `https://github.com/o/r/commit/${String(n).replace(/\D/g, '').padEnd(40, '0').slice(0, 40)}`, platform, keyed: true });
}
const ids = (q: string, limit = 10) => db.lexicalStore().search(queryTerms(q), limit).map(r => db.getDecisionById(r.id)!.title);
// Every read-only handle is closed before returning: Windows refuses to delete g.db while one is open (ALI-1784).
function readRaw<T>(fn: (raw: DatabaseSync) => T): T {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try { return fn(raw); } finally { raw.close(); }
}
const rawCount = (sql: string) => readRaw(raw => Object.values(raw.prepare(sql).get() as Record<string, number>)[0]!);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'align-lex-'));
  dbPath = path.join(dir, 'g.db');
  db = createLocalDb(dbPath);
});
afterEach(() => { db.close(); rmDir(dir); });

describe('lexical store: ranking', () => {
  it('finds the commit that names a kebab identifier, from its parts', () => {
    add('feat: switch routing to find-my-way', 'The previous router was slow.');
    add('docs: explain routing', 'Routing routing routing in the guide.');
    expect(ids('why do we use find my way for routing')[0]).toBe('feat: switch routing to find-my-way');
  });

  it('matches plural and singular: a question about processes finds a commit about a process', () => {
    add('drop the worker process', 'It leaked memory.');
    add('unrelated change', 'nothing');
    expect(ids('why were the processes dropped')).toEqual(['drop the worker process']);
  });

  it('finds an identifier in the BODY, not only the title', () => {
    add('refactor reply', 'rename setErrorHandler to onError');
    add('refactor request', 'rename send');
    expect(ids('why was setErrorHandler renamed')[0]).toBe('refactor reply');
  });

  it('a hit in a short commit outranks the same hit buried in a long one', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(' ');
    const long = add('long one', `zorblax ${filler}`);
    const short = add('short one', 'zorblax');
    const score = (id: string) => db.lexicalStore().search(queryTerms('zorblax'), 5).find(r => r.id === id)!.score;
    expect(score(short)).toBeGreaterThan(score(long));
  });

  it('weights a title hit above a body hit', () => {
    add('other words here', 'zod');
    add('zod', 'other words here');
    expect(ids('zod')[0]).toBe('zod');
  });

  it('breaks equal scores by id in code units, so the order is stable', () => {
    const a = add('pino', '', 'git', 1);
    const b = add('pino', '', 'git', 2);
    const got = db.lexicalStore().search(queryTerms('pino'), 5).map(r => r.id);
    expect(got).toEqual([a, b].sort());
  });

  it('equal scores from different terms still order by id, whichever term was asked first', () => {
    const x = add('alpha', '');
    const y = add('beta', '');
    const [low, high] = [x, y].sort();
    const termOf = (id: string) => (id === x ? 'alpha' : 'beta');
    const got = db.lexicalStore().search(queryTerms(`${termOf(high!)} ${termOf(low!)}`), 5).map(r => r.id);
    expect(got).toEqual([low, high]);
  });

  it('returns nothing when no term matches, and honours the limit', () => {
    for (let i = 0; i < 3; i++) add(`pino ${i}`, '');
    expect(ids('kubernetes')).toEqual([]);
    expect(ids('pino', 2)).toHaveLength(2);
  });

  it('indexes git decisions only: a slack row naming the term is invisible to it', () => {
    add('pino in slack', 'pino', 'slack');
    expect(ids('pino')).toEqual([]);
    expect(rawCount('SELECT COUNT(*) FROM lex_doc')).toBe(0);
  });
});

describe('lexical store: persisted, lazily, per row', () => {
  it('a second connection reads the index without writing anything', () => {
    add('feat: adopt zorblax', 'Because the old one was slow.');
    expect(ids('zorblax')).toEqual(['feat: adopt zorblax']);
    const second = createLocalDb(dbPath);
    const watcher = new DatabaseSync(dbPath, { readOnly: true });
    const version = () => (watcher.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
    try {
      const before = version();
      expect(second.lexicalStore().search(queryTerms('zorblax'), 5)).toHaveLength(1);
      expect(version()).toBe(before);
    } finally { second.close(); watcher.close(); }
  });

  it('an edited row is re-tokenised: the new word hits and the old one does not', () => {
    const id = add('feat: adopt zorblax', 'plain body');
    expect(ids('zorblax')).toHaveLength(1);
    db.insertDecision({ title: 'feat: adopt quuxmatic', summary: `feat: adopt quuxmatic\n\nplain body${meta}`, sourceUrl: db.getDecisionById(id)!.sourceUrl, platform: 'git', keyed: true });
    expect(ids('zorblax')).toEqual([]);
    expect(ids('quuxmatic')).toEqual(['feat: adopt quuxmatic']);
  });

  it('a deleted row leaves the index', () => {
    const id = add('feat: adopt zorblax', '');
    expect(ids('zorblax')).toHaveLength(1);
    const raw = new DatabaseSync(dbPath);
    raw.prepare('DELETE FROM decisions WHERE id = ?').run(id);
    raw.close();
    expect(ids('zorblax')).toEqual([]);
    expect(rawCount('SELECT COUNT(*) FROM lex_doc')).toBe(0);
    expect(rawCount('SELECT COUNT(*) FROM lex_term')).toBe(0);
  });

  it('rows stored under an older recipe are rebuilt, and rows under the current one are not touched', () => {
    add('feat: adopt zorblax', 'one');
    add('feat: adopt quuxmatic', 'two');
    expect(ids('zorblax')).toHaveLength(1);
    const raw = new DatabaseSync(dbPath);
    const numOf = (word: string) => `(SELECT num FROM lex_doc WHERE decision_id = (SELECT id FROM decisions WHERE title LIKE '%${word}%'))`;
    raw.exec(`UPDATE lex_doc SET sig = '0:old' WHERE num = ${numOf('zorblax')}`);
    raw.exec(`DELETE FROM lex_term WHERE num = ${numOf('zorblax')}`);
    const quuxRows = raw.prepare(`SELECT term, tf FROM lex_term WHERE num = ${numOf('quuxmatic')} ORDER BY term`).all();
    raw.close();
    const second = createLocalDb(dbPath);
    try {
      expect(second.lexicalStore().search(queryTerms('zorblax'), 5)).toHaveLength(1);
      const sig = readRaw(raw => raw.prepare(`SELECT sig FROM lex_doc WHERE decision_id = (SELECT id FROM decisions WHERE title LIKE '%zorblax%')`).get() as { sig: string });
      expect(sig.sig.startsWith(`${LEXICAL_RECIPE}:`)).toBe(true);
      const after = readRaw(raw => raw.prepare(`SELECT term, tf FROM lex_term WHERE num = ${numOf('quuxmatic')} ORDER BY term`).all());
      expect(after).toEqual(quuxRows);
    } finally { second.close(); }
  });

  it('old rows and rows added later coexist: the new one is found, the old one is not re-tokenised', () => {
    add('feat: adopt zorblax', 'old row');
    expect(ids('zorblax')).toHaveLength(1);
    const oldTerms = rawCount('SELECT COUNT(*) FROM lex_term');
    add('feat: adopt quuxmatic', 'new row');
    expect(ids('quuxmatic')).toEqual(['feat: adopt quuxmatic']);
    expect(ids('zorblax')).toEqual(['feat: adopt zorblax']);
    expect(rawCount('SELECT COUNT(*) FROM lex_term')).toBeGreaterThan(oldTerms);
    expect(rawCount('SELECT COUNT(*) FROM lex_doc')).toBe(2);
  });

  it('picks up a row another connection added after this store first built', () => {
    add('feat: adopt zorblax', '');
    expect(ids('zorblax')).toHaveLength(1);
    const other = createLocalDb(dbPath);
    other.insertDecision({ title: 'feat: adopt quuxmatic', summary: `feat: adopt quuxmatic${meta}`, sourceUrl: `https://github.com/o/r/commit/${'9'.repeat(40)}`, platform: 'git' });
    other.close();
    expect(ids('quuxmatic')).toEqual(['feat: adopt quuxmatic']);
  });

  it('creates no lexical table for a graph that never searches', () => {
    add('feat: adopt zorblax', '');
    expect(rawCount(`SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'lex_%'`)).toBe(0);
  });

  it('removing a decision through the shared remover takes its lexical rows with it', () => {
    const id = add('feat: adopt zorblax', 'body');
    add('feat: adopt quuxmatic', 'body');
    expect(ids('zorblax')).toHaveLength(1);
    const raw = new DatabaseSync(dbPath);
    deleteDecisionWithDependents(raw, id);
    raw.close();
    expect(rawCount('SELECT COUNT(*) FROM lex_doc')).toBe(1);
    expect(rawCount(`SELECT COUNT(*) FROM lex_term WHERE term = 'zorblax'`)).toBe(0);
  });

  it('a search behind another connection\'s write lock gives up after a short wait and leaves the 30 s timeout in place', () => {
    add('feat: adopt zorblax', 'body');
    const mine = new DatabaseSync(dbPath);
    mine.exec('PRAGMA busy_timeout = 30000');
    const store = createLexicalStore(mine);
    const other = new DatabaseSync(dbPath);
    other.exec('BEGIN IMMEDIATE');
    try {
      const started = Date.now();
      expect(() => store.search(queryTerms('zorblax'), 5)).toThrow();
      expect(Date.now() - started).toBeLessThan(10_000);
      expect((mine.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(30_000);
    } finally { other.exec('ROLLBACK'); other.close(); mine.close(); }
    expect(ids('zorblax')).toEqual(['feat: adopt zorblax']);
  });
});
