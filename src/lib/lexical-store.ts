import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { indexBodyFor } from './lexical-text.js';
import { termCounts } from './lexical-terms.js';

/**
 * The persisted lexical index of a local graph.
 *
 * Why persisted: building an in-memory index per process cost +53 ms on a 1,415-row graph and +298 ms on a
 * 2,000-row one, on every `align ask` and every advisory hook. Here each git decision's term counts live in
 * the graph's own SQLite file, built lazily on the first search and refreshed only for rows that changed, so a
 * later process reads a few postings lists and tokenises nothing.
 *
 * Only git decisions are indexed. Every other platform keeps exactly the ranking it had before, because it
 * has no lexical list to fuse (hybrid-rank.ts), and the tables stay empty for a graph with no commits.
 *
 * Tables are created lazily here, not in the schema migrations: an older CLI opening the same file ignores
 * them, and a graph that never searches never grows them.
 *
 * LEXICAL_RECIPE is the version of how a row becomes terms (tokeniser, stemmer, title weight, body length).
 * A row stored under another recipe is stale and is rebuilt on the next search. Dense vectors are NOT part
 * of it and are never touched.
 */
export const LEXICAL_RECIPE = 1;

const K1 = 1.2;
const B = 0.75;

// Terms are keyed by a small integer, not the decision's UUID: a UUID in the b-tree made the index larger
// than the graph's own text for a 2,000-commit repo, and an integer is a quarter of the size.
const DDL = `
CREATE TABLE IF NOT EXISTS lex_doc (num INTEGER PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE, sig TEXT NOT NULL, len REAL NOT NULL);
CREATE TABLE IF NOT EXISTS lex_term (term TEXT NOT NULL, num INTEGER NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY (term, num)) WITHOUT ROWID;
`;

interface State { key: string; n: number; avgLen: number; docs: Map<number, { id: string; len: number }> }

function signature(title: string, summary: string): string {
  const h = createHash('sha1').update(title).update('\0').update(summary).digest('base64').slice(0, 16);
  return `${LEXICAL_RECIPE}:${h}`;
}

export interface LexicalStore {
  /** Ranked ids for weighted query terms (term -> weight), best first. Ties break on id in code units. */
  search(terms: ReadonlyMap<string, number>, limit: number): Array<{ id: string; score: number }>;
}

export function createLexicalStore(db: DatabaseSync): LexicalStore {
  let state: State | undefined;

  const stamp = (): string => {
    const version = (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
    const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    return `${version}:${changes}`;
  };

  /** What differs between the git rows and the stored index. Read-only. */
  function plan() {
    const rows = db.prepare(`SELECT id, title, summary FROM decisions WHERE platform = 'git'`).all() as unknown as Array<{ id: string; title: string; summary: string }>;
    const stored = new Map((db.prepare('SELECT num, decision_id, sig, len FROM lex_doc').all() as unknown as Array<{ num: number; decision_id: string; sig: string; len: number }>)
      .map(r => [r.decision_id, r]));
    const live = new Set(rows.map(r => r.id));
    const gone = [...stored.values()].filter(d => !live.has(d.decision_id));
    const fresh = rows.map(r => ({ r, sig: signature(r.title, r.summary) })).filter(x => stored.get(x.r.id)?.sig !== x.sig);
    const docs = new Map<number, { id: string; len: number }>();
    for (const d of stored.values()) if (live.has(d.decision_id)) docs.set(d.num, { id: d.decision_id, len: d.len });
    return { gone, fresh, stored, docs };
  }

  /** Bring lex_doc and lex_term in line with the git rows. Only rows whose signature moved are tokenised. */
  function refresh(): State {
    // A search must not sit behind an import's write lock for the graph's 30 s (the DDL below needs that lock
    // too): wait briefly, then the caller falls back to the dense order. Put back to 30 s afterwards.
    db.exec('PRAGMA busy_timeout = 2000');
    try {
      return refreshLocked();
    } finally {
      db.exec('PRAGMA busy_timeout = 30000');
    }
  }

  function refreshLocked(): State {
    db.exec(DDL);
    // Stamped BEFORE reading, so a commit that lands while we read makes the next call refresh again
    // instead of being hidden behind a stamp taken after it.
    let key = stamp();
    let p = plan();
    if (p.gone.length || p.fresh.length) {
      const upsert = db.prepare(`INSERT INTO lex_doc (decision_id, sig, len) VALUES (?, ?, 0)
        ON CONFLICT(decision_id) DO UPDATE SET sig = excluded.sig RETURNING num`);
      const setLen = db.prepare('UPDATE lex_doc SET len = ? WHERE num = ?');
      const putTerm = db.prepare('INSERT INTO lex_term (term, num, tf) VALUES (?, ?, ?)');
      db.exec('BEGIN IMMEDIATE');
      try {
        // Planned again under the write lock: another process may have refreshed the same rows while we waited.
        p = plan();
        const stale = [...p.gone.map(d => d.num), ...p.fresh.flatMap(x => (p.stored.get(x.r.id) ? [p.stored.get(x.r.id)!.num] : []))];
        // One scan per 500 numbers: removing by number without an index on it costs a scan, and an index would cost more space.
        for (let i = 0; i < stale.length; i += 500) {
          const chunk = stale.slice(i, i + 500);
          db.prepare(`DELETE FROM lex_term WHERE num IN (${chunk.map(() => '?').join(',')})`).run(...chunk);
        }
        for (const d of p.gone) db.prepare('DELETE FROM lex_doc WHERE num = ?').run(d.num);
        for (const { r, sig } of p.fresh) {
          const { num } = upsert.get(r.id, sig) as { num: number };
          const counts = termCounts(r.title, indexBodyFor(r.title, r.summary));
          let len = 0;
          for (const [term, tf] of counts) { putTerm.run(term, num, tf); len += tf; }
          setLen.run(len, num);
          p.docs.set(num, { id: r.id, len });
        }
        // Inside the write lock no other process can commit, so this stamp covers exactly what we read and wrote.
        key = stamp();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    let total = 0;
    for (const d of p.docs.values()) total += d.len;
    return { key, n: p.docs.size, avgLen: p.docs.size ? total / p.docs.size : 0, docs: p.docs };
  }

  return {
    search(terms, limit) {
      if (!state || state.key !== stamp()) state = refresh();
      const { n, avgLen, docs } = state;
      if (!n) return [];
      const postings = db.prepare('SELECT num, tf FROM lex_term WHERE term = ?');
      const scores = new Map<string, number>();
      for (const [term, weight] of terms) {
        const rows = postings.all(term) as unknown as Array<{ num: number; tf: number }>;
        if (!rows.length) continue;
        const idf = Math.log(1 + (n - rows.length + 0.5) / (rows.length + 0.5));
        for (const { num, tf } of rows) {
          const doc = docs.get(num);
          if (!doc) continue;
          scores.set(doc.id, (scores.get(doc.id) ?? 0) + weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.len / avgLen)))));
        }
      }
      return [...scores].map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit);
    },
  };
}
