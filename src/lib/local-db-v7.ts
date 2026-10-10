/**
 * Schema v7 (plan phase L2): one bump for sync state, source identity, enrichment and local
 * judgements. Called from migrate() in local-db-migrate.ts, inside the `version < 7` branch.
 *
 * What it adds:
 * - `source_sync`: one row per (source, scope) - window, watermark, status and who changed it
 *   (`changed_via` cli|mcp, plus the agent for mcp). A widened scope is a NEW row, so it starts
 *   a fresh window instead of inheriting the narrow scope's watermark.
 * - `decisions.source_key`: the identity of a one-item-per-URL connector item
 *   (source-key.ts). (source_url, title) stays the identity of every other row, because a
 *   session transcript or a manual capture can hold several decisions under one URL.
 * - `decisions.detail_pending`: 1 while a GitHub item's discussion has not been fetched yet.
 * - `decisions.enriched_at`: set by ingestOne as its LAST write, after the link pass. NULL on
 *   every row that exists at upgrade, on purpose: nothing on disk tells a finished ingest from
 *   one that died between embedding and linking, so every row is re-linked once by the next
 *   sync (Decision 30). The migration itself does no re-linking, so it stays fast.
 * - `local_judgements`: a person's verdict on a decision, with judge, time and cli|mcp origin.
 *   No foreign key to `decisions`, like C7's `promotions`: a purge must not erase a record the
 *   user may still want to share. Ratification is not here (Decision 14).
 * - `decisions_merged_backup`: every row the twin merge deletes, so the merge can be undone
 *   with an INSERT ... SELECT back.
 *
 * Twin merge (Decision 3). v6 keyed rows on (source_url, title), so an edited PR or issue title
 * wrote a second row for the same item. Rows sharing a source_key are merged: the survivor is
 * the ratified row (the first ratified, if several), else the most recently inserted. It takes
 * the newest row's title, summary and embedding, because the newest text is the item as it
 * stands. Everything that named a loser is re-pointed; a link between two twins is dropped
 * rather than turned into a self-link; a duplicate link keeps the higher confidence.
 *
 * Replay-safe: every CREATE is IF NOT EXISTS, every ALTER is guarded by table_info, keys are
 * computed only where NULL, and a second pass finds no group of twins left to merge.
 */
import type { DatabaseSync } from 'node:sqlite';
import { normaliseSourceKey } from './source-key.js';

const V7_TABLES = `
CREATE TABLE IF NOT EXISTS source_sync (
  source_id        TEXT NOT NULL,
  scope_key        TEXT NOT NULL,
  scope            TEXT NOT NULL CHECK (scope IN ('yours', 'team')),
  window_since     TEXT,
  high_water       TEXT,
  pending_until    TEXT,
  status           TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'partial', 'needs_reauth', 'error')),
  last_started_at  TEXT,
  last_success_at  TEXT,
  items_last_run   INTEGER,
  skips_last_run   TEXT,
  changed_via      TEXT CHECK (changed_via IS NULL OR changed_via IN ('cli', 'mcp')),
  changed_by_agent TEXT,
  PRIMARY KEY (source_id, scope_key)
);

CREATE TABLE IF NOT EXISTS local_judgements (
  id             TEXT PRIMARY KEY,
  decision_id    TEXT NOT NULL,
  counterpart_id TEXT,
  context_key    TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('conflict_verdict', 'check_verdict', 'supersede', 'not_a_decision', 'note')),
  value          TEXT CHECK (value IS NULL OR value IN ('real', 'false')),
  note           TEXT,
  judge_id       TEXT NOT NULL,
  judge_label    TEXT,
  via            TEXT NOT NULL CHECK (via IN ('cli', 'mcp')),
  agent_id       TEXT,
  judged_at      TEXT NOT NULL,
  CHECK ((via = 'mcp') = (agent_id IS NOT NULL)),
  CHECK ((kind = 'check_verdict') = (context_key IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_local_judgements_person
  ON local_judgements (decision_id, COALESCE(counterpart_id, context_key, decision_id), judge_id, kind)
  WHERE kind <> 'note';
`;

/** Created LAST: the source_key index cannot build while twins still share a key. */
const V7_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_decisions_source_key ON decisions(source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_detail_pending ON decisions(platform, decided_at) WHERE detail_pending = 1;
CREATE INDEX IF NOT EXISTS idx_decisions_not_enriched ON decisions(created_at) WHERE enriched_at IS NULL;
`;

const V7_COLUMNS: Array<[name: string, ddl: string]> = [
  ['source_key', 'source_key TEXT'],
  ['detail_pending', 'detail_pending INTEGER NOT NULL DEFAULT 0'],
  ['enriched_at', 'enriched_at TEXT'],
];

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
}

/** Rows naming `from` now name `to`. A row whose re-pointed key already exists is left on the
 *  loser's id (the loser is in the backup table), never deleted: losing a record is the
 *  destructive direction, and an orphan pointing at a backed-up row can still be restored. */
function repoint(db: DatabaseSync, table: string, column: string, from: string, to: string): void {
  db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`).run(to, from);
}

function repointLinks(db: DatabaseSync, loser: string, survivor: string, group: Set<string>): void {
  const links = db.prepare(`SELECT id, source_id AS s, target_id AS t, relation, confidence FROM decision_links WHERE source_id = ? OR target_id = ?`)
    .all(loser, loser) as Array<{ id: string; s: string; t: string; relation: string; confidence: number }>;
  for (const link of links) {
    const s = link.s === loser ? survivor : link.s;
    const t = link.t === loser ? survivor : link.t;
    // A link between two twins of one item would become a self-link: drop it.
    if (s === t || (group.has(s) && group.has(t))) {
      db.prepare('DELETE FROM decision_links WHERE id = ?').run(link.id);
      continue;
    }
    const existing = db.prepare('SELECT id FROM decision_links WHERE source_id = ? AND target_id = ? AND relation = ?')
      .get(s, t, link.relation) as { id: string } | undefined;
    if (existing) {
      db.prepare('UPDATE decision_links SET confidence = MAX(confidence, ?) WHERE id = ?').run(link.confidence, existing.id);
      db.prepare('DELETE FROM decision_links WHERE id = ?').run(link.id);
    } else {
      db.prepare('UPDATE decision_links SET source_id = ?, target_id = ? WHERE id = ?').run(s, t, link.id);
    }
  }
}

interface TwinRow { id: string; rowid: number; ratified_at: string | null }

function mergeGroup(db: DatabaseSync, key: string): void {
  const twins = db.prepare(`SELECT id, rowid, ratified_at FROM decisions WHERE source_key = ? ORDER BY rowid`)
    .all(key) as unknown as TwinRow[];
  const newest = twins[twins.length - 1];
  const ratified = twins.filter(t => t.ratified_at !== null)
    .sort((a, b) => (a.ratified_at! < b.ratified_at! ? -1 : a.ratified_at! > b.ratified_at! ? 1 : a.rowid - b.rowid));
  const survivor = ratified[0] ?? newest;
  const losers = twins.filter(t => t.id !== survivor.id);
  const group = new Set(twins.map(t => t.id));
  const hasJudgements = tableExists(db, 'local_judgements');
  const hasPromotions = tableExists(db, 'promotions');
  // The newest text, read before the newest row can be deleted as a loser.
  const latest = db.prepare('SELECT title, summary, source_url, repo, decided_at FROM decisions WHERE id = ?')
    .get(newest.id) as { title: string; summary: string; source_url: string | null; repo: string | null; decided_at: string | null };

  for (const loser of losers) {
    db.prepare('INSERT INTO decisions_merged_backup SELECT * FROM decisions WHERE id = ?').run(loser.id);
    repoint(db, 'decision_audit', 'decision_id', loser.id, survivor.id);
    repointLinks(db, loser.id, survivor.id, group);
    repoint(db, 'decision_refs', 'decision_id', loser.id, survivor.id);
    if (hasJudgements) {
      repoint(db, 'local_judgements', 'decision_id', loser.id, survivor.id);
      repoint(db, 'local_judgements', 'counterpart_id', loser.id, survivor.id);
    }
    if (hasPromotions) repoint(db, 'promotions', 'local_id', loser.id, survivor.id);
    // Refs the survivor already had stay as they are; the loser's leftovers are duplicates.
    db.prepare('DELETE FROM decision_refs WHERE decision_id = ?').run(loser.id);
    if (loser.id === newest.id) {
      // The survivor takes the newest text, so it takes the vector OF that text.
      const moved = db.prepare('SELECT 1 AS hit FROM decision_embeddings WHERE decision_id = ?').get(loser.id);
      if (moved) {
        db.prepare('DELETE FROM decision_embeddings WHERE decision_id = ?').run(survivor.id);
        db.prepare('UPDATE decision_embeddings SET decision_id = ? WHERE decision_id = ?').run(survivor.id, loser.id);
      }
    }
    db.prepare('DELETE FROM decision_embeddings WHERE decision_id = ?').run(loser.id);
    db.prepare('DELETE FROM decisions WHERE id = ?').run(loser.id);
    db.prepare(`INSERT INTO decision_audit (id, decision_id, action, actor, detail) VALUES (lower(hex(randomblob(16))), ?, 'merged', 'migration', ?)`)
      .run(survivor.id, loser.id);
  }
  db.prepare(
    `UPDATE decisions SET title = ?, summary = ?, source_url = ?, repo = COALESCE(?, repo), decided_at = COALESCE(?, decided_at)
     WHERE id = ?`,
  ).run(latest.title, latest.summary, latest.source_url, latest.repo, latest.decided_at, survivor.id);
}

export function migrateV7(db: DatabaseSync): void {
  const existing = columnsOf(db, 'decisions');
  for (const [name, ddl] of V7_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE decisions ADD COLUMN ${ddl}`);
  }
  db.exec(V7_TABLES);
  // After the ALTERs, so the backup carries every column a row can hold.
  db.exec('CREATE TABLE IF NOT EXISTS decisions_merged_backup AS SELECT * FROM decisions WHERE 0');

  const unkeyed = db.prepare('SELECT id, platform, source_url FROM decisions WHERE source_key IS NULL AND source_url IS NOT NULL')
    .all() as Array<{ id: string; platform: string; source_url: string }>;
  const setKey = db.prepare('UPDATE decisions SET source_key = ? WHERE id = ?');
  for (const row of unkeyed) {
    const key = normaliseSourceKey(row.platform, row.source_url);
    if (key !== undefined) setKey.run(key, row.id);
  }

  const groups = db.prepare('SELECT source_key AS k FROM decisions WHERE source_key IS NOT NULL GROUP BY source_key HAVING count(*) > 1')
    .all() as Array<{ k: string }>;
  for (const { k } of groups) mergeGroup(db, k);

  db.exec(V7_INDEXES);
}
