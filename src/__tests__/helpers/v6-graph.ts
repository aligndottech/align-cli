/**
 * A local graph file at schema v6 - the shape every installed CLI before L2 writes - built
 * through the v6 writers' own SQL, so the L2 migration is tested against what is really on
 * users' disks rather than against a description of it (tdd.md, "fifth shape").
 *
 * Why raw SQL and not today's `insertDecision`: L2 makes `insertDecision` upsert on
 * `source_key`, so it can no longer produce the twin rows (same item URL, edited title) that
 * v6 produced and the migration must merge. `insertDecision` below is v6's INSERT verbatim
 * (git show 81c7246:src/lib/local-db.ts), keyed on (source_url, title) only.
 */
import { DatabaseSync } from 'node:sqlite';

export const V6_SCHEMA = `
CREATE TABLE decisions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, source_url TEXT,
  platform TEXT NOT NULL DEFAULT 'cli', created_at TEXT NOT NULL DEFAULT (datetime('now')),
  repo TEXT, decided_at TEXT, decider_kind TEXT, confirmed_by TEXT, confirmed_at TEXT,
  ratified_by TEXT, ratified_at TEXT
);
CREATE TABLE decision_audit (id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE decision_embeddings (decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE, embedding BLOB NOT NULL, model TEXT);
CREATE TABLE decision_links (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE decision_refs (decision_id TEXT NOT NULL, ref TEXT NOT NULL, platform TEXT NOT NULL, PRIMARY KEY (decision_id, ref));
CREATE UNIQUE INDEX decisions_source_title_unique ON decisions(source_url, title);
CREATE UNIQUE INDEX decision_links_triple_unique ON decision_links(source_id, target_id, relation);
PRAGMA user_version = 6;
`;

export function createV6Graph(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  db.exec(V6_SCHEMA);
  return {
    raw: db,
    /** v6 insertDecision: upsert on (source_url, title), so an edited title is a new row. */
    insertDecision(row: { id: string; title: string; summary: string; sourceUrl: string | null; platform: string }): string {
      const r = db.prepare(
        `INSERT INTO decisions (id, title, summary, source_url, platform) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_url, title) DO UPDATE SET summary = excluded.summary, platform = excluded.platform
         RETURNING id`,
      ).get(row.id, row.title, row.summary, row.sourceUrl, row.platform) as { id: string };
      return r.id;
    },
    /** v6 markRatified. */
    markRatified(id: string, by: string): void {
      db.prepare(`UPDATE decisions SET ratified_by = ?, ratified_at = ? WHERE id = ? AND ratified_at IS NULL`)
        .run(by, new Date().toISOString(), id);
    },
    /** v6 insertAudit. */
    insertAudit(id: string, decisionId: string, action: string): void {
      db.prepare(`INSERT INTO decision_audit (id, decision_id, action, actor) VALUES (?, ?, ?, 'tom')`).run(id, decisionId, action);
    },
    /** v6 insertLink. */
    insertLink(id: string, sourceId: string, targetId: string, relation: string, confidence: number): void {
      db.prepare(`INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?, ?)`)
        .run(id, sourceId, targetId, relation, confidence);
    },
    insertRef(decisionId: string, ref: string, platform: string): void {
      db.prepare(`INSERT INTO decision_refs (decision_id, ref, platform) VALUES (?, ?, ?)`).run(decisionId, ref, platform);
    },
    setEmbedding(decisionId: string, fill: number): void {
      db.prepare(`INSERT INTO decision_embeddings (decision_id, embedding, model) VALUES (?, ?, 'Xenova/all-MiniLM-L6-v2')`)
        .run(decisionId, Buffer.from(new Float32Array(4).fill(fill).buffer));
    },
    close(): void { db.close(); },
  };
}

export function count(dbPath: string, sql: string, ...params: Array<string | number>): number {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(sql).get(...params) as { n: number }).n;
  } finally {
    db.close();
  }
}

export function columnsOf(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
  } finally {
    db.close();
  }
}
