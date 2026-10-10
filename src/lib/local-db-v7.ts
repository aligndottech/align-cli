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
 * - `decisions_merged_backup`, `decision_embeddings_merged_backup`, `decision_refs_merged_backup`:
 *   every decision row the twin merge deletes, with that row's vector and refs. That is what a
 *   restore can recover (INSERT ... SELECT the three back). It is NOT a full undo: links, audit
 *   rows, local judgements and promotions that named a loser were RE-POINTED at the survivor
 *   (a link between two twins, and a duplicate link's lower confidence, were dropped), and are
 *   not copied anywhere. A restored loser comes back without them.
 *
 * Twin merge (Decision 3). v6 keyed rows on (source_url, title), so an edited PR or issue title
 * wrote a second row for the same item. Rows sharing a source_key are merged: the survivor is
 * the first ratified row, else the first confirmed row, else the most recently inserted. An
 * unattested survivor holds the newest text (it is the newest row). An attested survivor KEEPS
 * its own text and vector, and the newer text is stored as a `text_revision_pending` audit note
 * (mergeGroup). Everything that named a loser is re-pointed; a link between two twins is dropped
 * rather than turned into a self-link; a duplicate link keeps the higher confidence.
 *
 * Replay-safe: every CREATE is IF NOT EXISTS, every ALTER is guarded by table_info, keys are
 * computed only where NULL, and a second pass finds no group of twins left to merge.
 */
import type { DatabaseSync } from 'node:sqlite';
import { isCaptureShaped } from './local-ingest.js';
import { connectorItemKey } from './source-key.js';

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

/** Fold one twin into its survivor: back the row up, re-point everything that named it, delete
 *  it. The loser's vector is dropped: the survivor keeps its own text, so it keeps its own
 *  vector (a survivor that takes newer text is the newest row, which already holds that
 *  text's vector). Also used by insertDecision to absorb a keyless row written by an older
 *  binary. */
export function absorbLoser(db: DatabaseSync, loserId: string, survivorId: string, group: Set<string>): void {
  const hasJudgements = tableExists(db, 'local_judgements');
  const hasPromotions = tableExists(db, 'promotions');
  db.prepare('INSERT INTO decisions_merged_backup SELECT * FROM decisions WHERE id = ?').run(loserId);
  db.prepare('INSERT INTO decision_embeddings_merged_backup SELECT * FROM decision_embeddings WHERE decision_id = ?').run(loserId);
  db.prepare('INSERT INTO decision_refs_merged_backup SELECT * FROM decision_refs WHERE decision_id = ?').run(loserId);
  repoint(db, 'decision_audit', 'decision_id', loserId, survivorId);
  repointLinks(db, loserId, survivorId, group);
  repoint(db, 'decision_refs', 'decision_id', loserId, survivorId);
  if (hasJudgements) {
    repoint(db, 'local_judgements', 'decision_id', loserId, survivorId);
    repoint(db, 'local_judgements', 'counterpart_id', loserId, survivorId);
  }
  if (hasPromotions) repoint(db, 'promotions', 'local_id', loserId, survivorId);
  // Refs the survivor already had stay as they are; the loser's leftovers are duplicates.
  db.prepare('DELETE FROM decision_refs WHERE decision_id = ?').run(loserId);
  db.prepare('DELETE FROM decision_embeddings WHERE decision_id = ?').run(loserId);
  db.prepare('DELETE FROM decisions WHERE id = ?').run(loserId);
  db.prepare(`INSERT INTO decision_audit (id, decision_id, action, actor, detail) VALUES (lower(hex(randomblob(16))), ?, 'merged', 'migration', ?)`)
    .run(survivorId, loserId);
}

interface TwinRow {
  id: string; rowid: number; created_at: string; title: string; summary: string;
  ratified_by: string | null; ratified_at: string | null; confirmed_by: string | null; confirmed_at: string | null;
}

/** Earliest first by the attestation time, ties by insertion order. */
function earliestBy(twins: TwinRow[], at: 'ratified_at' | 'confirmed_at'): TwinRow[] {
  return twins.filter(t => t[at] !== null)
    .sort((a, b) => (a[at]! < b[at]! ? -1 : a[at]! > b[at]! ? 1 : a.rowid - b.rowid));
}

/**
 * Survivor: the earliest ratified row, else the earliest confirmed row, else the newest. A row
 * a person ratified or confirmed keeps ITS text and vector: the attestation covers text they
 * read, so newer upstream text is recorded as a `text_revision_pending` audit note instead of
 * replacing it. An unattested survivor (the newest row) holds the newest text already. Either
 * way the survivor keeps the earliest created_at and carries any ratification or confirmation
 * a loser held that it lacks.
 */
function mergeGroup(db: DatabaseSync, key: string): void {
  const twins = db.prepare(
    `SELECT id, rowid, created_at, title, summary, ratified_by, ratified_at, confirmed_by, confirmed_at
     FROM decisions WHERE source_key = ? ORDER BY rowid`,
  ).all(key) as unknown as TwinRow[];
  const newest = twins[twins.length - 1]!;
  const ratified = earliestBy(twins, 'ratified_at')[0];
  const confirmed = earliestBy(twins, 'confirmed_at')[0];
  const attested = ratified ?? confirmed;
  const survivor = attested ?? newest;
  const group = new Set(twins.map(t => t.id));
  const earliestCreated = twins.map(t => t.created_at).sort()[0]!;
  const latest = db.prepare('SELECT source_url, repo, decided_at FROM decisions WHERE id = ?')
    .get(newest.id) as { source_url: string | null; repo: string | null; decided_at: string | null };

  for (const loser of twins.filter(t => t.id !== survivor.id)) absorbLoser(db, loser.id, survivor.id, group);

  if (attested === undefined) {
    db.prepare('UPDATE decisions SET source_url = ?, repo = COALESCE(?, repo), decided_at = COALESCE(?, decided_at) WHERE id = ?')
      .run(latest.source_url, latest.repo, latest.decided_at, survivor.id);
  } else {
    db.prepare('UPDATE decisions SET repo = COALESCE(?, repo), decided_at = COALESCE(?, decided_at) WHERE id = ?')
      .run(latest.repo, latest.decided_at, survivor.id);
    if (newest.id !== survivor.id && (newest.title !== survivor.title || newest.summary !== survivor.summary)) {
      db.prepare(`INSERT INTO decision_audit (id, decision_id, action, actor, detail) VALUES (lower(hex(randomblob(16))), ?, 'text_revision_pending', 'migration', ?)`)
        .run(survivor.id, JSON.stringify({ title: newest.title, summary: newest.summary }));
    }
  }
  db.prepare(
    `UPDATE decisions SET created_at = ?,
       ratified_by = COALESCE(ratified_by, ?), ratified_at = COALESCE(ratified_at, ?),
       confirmed_by = COALESCE(confirmed_by, ?), confirmed_at = COALESCE(confirmed_at, ?)
     WHERE id = ?`,
  ).run(earliestCreated, ratified?.ratified_by ?? null, ratified?.ratified_at ?? null,
    confirmed?.confirmed_by ?? null, confirmed?.confirmed_at ?? null, survivor.id);
}

export function migrateV7(db: DatabaseSync): void {
  const existing = columnsOf(db, 'decisions');
  for (const [name, ddl] of V7_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE decisions ADD COLUMN ${ddl}`);
  }
  db.exec(V7_TABLES);
  // After the ALTERs, so the backup carries every column a row can hold.
  db.exec('CREATE TABLE IF NOT EXISTS decisions_merged_backup AS SELECT * FROM decisions WHERE 0');
  db.exec('CREATE TABLE IF NOT EXISTS decision_embeddings_merged_backup AS SELECT * FROM decision_embeddings WHERE 0');
  db.exec('CREATE TABLE IF NOT EXISTS decision_refs_merged_backup AS SELECT * FROM decision_refs WHERE 0');

  // Only rows that look like connector imports are keyed. A v6 row cannot say how it was
  // written, and `align capture <PR url>` wrote platform github too, so the rule is on the
  // row: a capture has the summary "Captured from <host>" or the URL's last path segment as
  // its title (isCaptureShaped). Those stay unkeyed. When unsure, do not merge: the cost of
  // a missed twin is a duplicate the next sync can still resolve, the cost of a wrong merge
  // is a lost record.
  const unkeyed = db.prepare('SELECT id, platform, source_url, title, summary FROM decisions WHERE source_key IS NULL AND source_url IS NOT NULL')
    .all() as Array<{ id: string; platform: string; source_url: string; title: string; summary: string }>;
  const setKey = db.prepare('UPDATE decisions SET source_key = ? WHERE id = ?');
  for (const row of unkeyed) {
    if (isCaptureShaped(row)) continue;
    const key = connectorItemKey(row.platform, row.source_url);
    if (key !== undefined) setKey.run(key, row.id);
  }

  const groups = db.prepare('SELECT source_key AS k FROM decisions WHERE source_key IS NOT NULL GROUP BY source_key HAVING count(*) > 1')
    .all() as Array<{ k: string }>;
  // The fold looks up links by target, audit rows and judgements by decision for every loser;
  // none of those has an index (links are indexed by source only), so 3k merges scanned the
  // tables 3k times. Temporary, created inside the migration's transaction and dropped with it.
  const temp: string[] = [
    'CREATE INDEX IF NOT EXISTS tmp_v7_links_target ON decision_links(target_id)',
    'CREATE INDEX IF NOT EXISTS tmp_v7_audit_decision ON decision_audit(decision_id)',
    'CREATE INDEX IF NOT EXISTS tmp_v7_judgements_counterpart ON local_judgements(counterpart_id)',
  ];
  if (groups.length > 0) for (const ddl of temp) db.exec(ddl);
  for (const { k } of groups) mergeGroup(db, k);
  for (const name of ['tmp_v7_links_target', 'tmp_v7_audit_decision', 'tmp_v7_judgements_counterpart']) {
    db.exec(`DROP INDEX IF EXISTS ${name}`);
  }

  db.exec(V7_INDEXES);
}
