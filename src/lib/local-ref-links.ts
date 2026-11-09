/**
 * Links made from an exact reference: a commit that says "fixes APP-123", and the Linear issue
 * APP-123 imported from Linear. No model is involved and the match is exact, so these links are
 * certain, free, and need no key.
 *
 * Two things make that hold:
 *
 * 1. BOTH DIRECTIONS. A link is made whichever side arrives second. The earlier version only
 *    resolved refs already waiting when the cited item arrived (git first, then Linear), so
 *    connecting Linear before importing git linked nothing. `decision_identities` records what
 *    each decision can be cited as (refIdentityFor), so a citer arriving later can find it.
 *
 * 2. STAMPED 'ref'. A certain link carries detector_version 'ref'. `align local relink` only
 *    re-types 'v0' links, and `replaceLink` (every model path: capture, `align sync --classify`,
 *    relink) never deletes a 'ref' link. Before this, a classifier verdict on the pair deleted the
 *    certain link and kept the model's guess.
 *
 * The relation stays `relates`: the shared vocabulary (connector-core DECISION_RELATIONSHIPS) has
 * no "implements", and a CLI-only value would fork it from the hosted product. 'ref' is what says
 * the link is certain.
 *
 * `decision_identities` is ADDITIVE (local-db-cochange.ts explains the rule): a new table nothing
 * older reads, so it does not bump user_version. An older CLI writes no identities for what it
 * inserts; those rows then link in the old one direction only. Readers join `decisions`, so a row
 * left behind by an older CLI's delete links nothing.
 */
import type { DatabaseSync } from 'node:sqlite';
import { refIdentityFor } from './decision-refs.js';
import { insertLinkRow } from './local-link-write.js';

export const REF_DETECTOR = 'ref' as const;

type Ref = { ref: string; platform: string };

export function hasIdentityTable(db: DatabaseSync): boolean {
  return db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'decision_identities'`).get() !== undefined;
}

/**
 * A bare `#N` names a pull request or issue in whichever forge hosts the repo, so it is only the
 * same item within one repo. Both repos known and different: not a match. Either unknown: a match,
 * which is what the one-directional resolver always did.
 */
function sameRepoOrUnknown(db: DatabaseSync, a: string, b: string): boolean {
  const repo = db.prepare('SELECT repo FROM decisions WHERE id = ?');
  const ra = (repo.get(a) as { repo: string | null } | undefined)?.repo ?? null;
  const rb = (repo.get(b) as { repo: string | null } | undefined)?.repo ?? null;
  return ra === null || rb === null || ra === rb;
}

function link(db: DatabaseSync, citer: string, cited: string, platform: string): void {
  if (citer === cited) return;
  if (platform === 'code' && !sameRepoOrUnknown(db, citer, cited)) return;
  insertLinkRow(db, { sourceId: citer, targetId: cited, relation: 'relates', confidence: 1.0, detectorVersion: REF_DETECTOR });
}

/**
 * Record what `id` can be cited as, then link it both ways: to every decision whose text already
 * cites it, and to every decision its own text cites. Idempotent: the unique index on
 * (source, target, relation) makes a repeat a no-op.
 */
export function linkByReference(db: DatabaseSync, id: string, identities: Ref[], ownRefs: Ref[]): void {
  db.prepare('DELETE FROM decision_identities WHERE decision_id = ?').run(id);
  const addIdentity = db.prepare('INSERT OR IGNORE INTO decision_identities (decision_id, ref, platform) VALUES (?, ?, ?)');
  for (const c of identities) addIdentity.run(id, c.ref, c.platform);

  const citers = db.prepare(
    `SELECT r.decision_id AS id FROM decision_refs r JOIN decisions d ON d.id = r.decision_id
      WHERE r.platform = ? AND r.ref = ? AND r.decision_id != ?`,
  );
  for (const c of identities) {
    for (const row of citers.all(c.platform, c.ref, id) as Array<{ id: string }>) link(db, row.id, id, c.platform);
  }

  const cited = db.prepare(
    `SELECT i.decision_id AS id FROM decision_identities i JOIN decisions d ON d.id = i.decision_id
      WHERE i.platform = ? AND i.ref = ? AND i.decision_id != ?`,
  );
  for (const r of ownRefs) {
    for (const row of cited.all(r.platform, r.ref, id) as Array<{ id: string }>) link(db, id, row.id, r.platform);
  }
}

/** Remove a decision's identities: the explicit-delete paths name every dependent (foreign keys are off). */
export function deleteIdentities(db: DatabaseSync, id: string): void {
  try { db.prepare('DELETE FROM decision_identities WHERE decision_id = ?').run(id); } catch { /* no table yet */ }
}

/**
 * Create the table, then bring an existing graph up to date in one pass: record every decision's
 * identity, link every ref that matches one, and so stamp the links the old resolver wrote (exact
 * matches stored as 'v0') as 'ref'. Runs once, when the table first appears.
 */
export function migrateRefLinks(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS decision_identities (
    decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    platform TEXT NOT NULL,
    PRIMARY KEY (decision_id, ref, platform)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_decision_identities_ref ON decision_identities (platform, ref)');
  const addIdentity = db.prepare('INSERT OR IGNORE INTO decision_identities (decision_id, ref, platform) VALUES (?, ?, ?)');
  const rows = db.prepare('SELECT id, platform, source_url AS sourceUrl FROM decisions WHERE source_url IS NOT NULL').all() as Array<{ id: string; platform: string; sourceUrl: string }>;
  for (const r of rows) for (const c of refIdentityFor(r.platform, r.sourceUrl)) addIdentity.run(r.id, c.ref, c.platform);

  const matches = db.prepare(
    `SELECT r.decision_id AS citer, i.decision_id AS cited, r.platform AS platform
       FROM decision_refs r JOIN decision_identities i ON i.platform = r.platform AND i.ref = r.ref
      WHERE r.decision_id != i.decision_id`,
  ).all() as Array<{ citer: string; cited: string; platform: string }>;
  for (const m of matches) link(db, m.citer, m.cited, m.platform);
}
