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
 * 2. STAMPED 'ref', WHEN CERTAIN. An unambiguous match carries detector_version 'ref' (see linker). `align local relink` only
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
 * The statements one pass uses, prepared once (a backfill links every ref in the graph inside one
 * write lock, so per-row prepares would hold that lock far longer), with repo lookups cached.
 */
function linker(db: DatabaseSync) {
  const repoOf = db.prepare('SELECT repo FROM decisions WHERE id = ?');
  const holders = db.prepare(
    `SELECT COUNT(DISTINCT i.decision_id) AS n FROM decision_identities i JOIN decisions d ON d.id = i.decision_id WHERE i.platform = ? AND i.ref = ?`,
  );
  // A bare #N is unique per repo, so "exactly one" is counted within the citer's repo.
  const holdersInRepo = db.prepare(
    `SELECT COUNT(DISTINCT i.decision_id) AS n FROM decision_identities i JOIN decisions d ON d.id = i.decision_id WHERE i.platform = ? AND i.ref = ? AND d.repo = ?`,
  );
  const repos = new Map<string, string | null>();
  const repo = (id: string): string | null => {
    if (!repos.has(id)) repos.set(id, (repoOf.get(id) as { repo: string | null } | undefined)?.repo ?? null);
    return repos.get(id)!;
  };
  /**
   * Certain only when exactly one decision carries the identity cited and, for a bare `#N` (which
   * names a pull request or issue in whichever forge hosts the repo), both repos are known and
   * equal. Anything else is still a likely link, written the way the old resolver wrote it ('v0',
   * so a model may re-type it), never stamped certain: two items both called APP-123 (a Jira and a
   * Linear one), or a `#12` from a commit with no known repo, are not certain.
   */
  return (citer: string, cited: string, ref: Ref): void => {
    if (citer === cited) return;
    let certain = (holders.get(ref.platform, ref.ref) as { n: number }).n === 1;
    if (ref.platform === 'code') {
      const a = repo(citer);
      const b = repo(cited);
      if (a !== null && b !== null && a !== b) return; // known to be different repos: not the same item
      certain = a !== null && b !== null && (holdersInRepo.get(ref.platform, ref.ref, a) as { n: number }).n === 1;
    }
    insertLinkRow(db, { sourceId: citer, targetId: cited, relation: 'relates', confidence: 1.0, detectorVersion: certain ? REF_DETECTOR : 'v0' });
  };
}

/**
 * Record what `id` can be cited as, then link it both ways: to every decision whose text already
 * cites it, and, when `ownRefs` is given, to every decision its own text cites. Idempotent: the
 * unique index on (source, target, relation) makes a repeat a no-op.
 *
 * `ownRefs` given (an ingest, which knows the decision's current text) also retires this
 * decision's own certain links first, so a link outlives no ref: rewrite a commit message so it no
 * longer cites APP-123 and its certain link to APP-123 goes. Omitted, the decision's own links are
 * left alone.
 */
export function linkByReference(db: DatabaseSync, id: string, identities: Ref[], ownRefs?: Ref[]): void {
  // One unit: a reader (the advisory hook opens the graph on every edit) never sees this decision
  // with its identities half-replaced, and an import pays one commit, not one per statement. A
  // SAVEPOINT, not BEGIN, because a caller may already hold a transaction.
  db.exec('SAVEPOINT link_by_reference');
  try {
    linkInOneUnit(db, id, identities, ownRefs);
    db.exec('RELEASE link_by_reference');
  } catch (err) {
    db.exec('ROLLBACK TO link_by_reference');
    db.exec('RELEASE link_by_reference');
    throw err;
  }
}

function linkInOneUnit(db: DatabaseSync, id: string, identities: Ref[], ownRefs?: Ref[]): void {
  db.prepare('DELETE FROM decision_identities WHERE decision_id = ?').run(id);
  const addIdentity = db.prepare('INSERT OR IGNORE INTO decision_identities (decision_id, ref, platform) VALUES (?, ?, ?)');
  for (const c of identities) addIdentity.run(id, c.ref, c.platform);
  const link = linker(db);

  const citers = db.prepare(
    `SELECT r.decision_id AS id FROM decision_refs r JOIN decisions d ON d.id = r.decision_id
      WHERE r.platform = ? AND r.ref = ? AND r.decision_id != ?`,
  );
  for (const c of identities) {
    for (const row of citers.all(c.platform, c.ref, id) as Array<{ id: string }>) link(row.id, id, c);
  }

  if (ownRefs === undefined) return;
  db.prepare(`DELETE FROM decision_links WHERE source_id = ? AND relation = 'relates' AND detector_version = ?`).run(id, REF_DETECTOR);
  const cited = db.prepare(
    `SELECT i.decision_id AS id FROM decision_identities i JOIN decisions d ON d.id = i.decision_id
      WHERE i.platform = ? AND i.ref = ? AND i.decision_id != ?`,
  );
  for (const r of ownRefs) {
    for (const row of cited.all(r.platform, r.ref, id) as Array<{ id: string }>) link(id, row.id, r);
  }
}

/** Remove a decision's identities: the explicit-delete paths name every dependent. */
export function deleteIdentities(db: DatabaseSync, id: string): void {
  try { db.prepare('DELETE FROM decision_identities WHERE decision_id = ?').run(id); } catch { /* no table yet */ }
}

/**
 * Create the table, then bring an existing graph up to date in one pass: record every decision's
 * identity, link every ref that matches one, and so stamp the links the old resolver wrote (exact
 * matches stored as 'v0') as 'ref' where they are unambiguous. Runs once, when the table first appears.
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

  const link = linker(db);
  const matches = db.prepare(
    `SELECT r.decision_id AS citer, i.decision_id AS cited, r.ref AS ref, r.platform AS platform
       FROM decision_refs r JOIN decision_identities i ON i.platform = r.platform AND i.ref = r.ref
      WHERE r.decision_id != i.decision_id`,
  ).all() as Array<{ citer: string; cited: string; ref: string; platform: string }>;
  for (const m of matches) link(m.citer, m.cited, { ref: m.ref, platform: m.platform });
}
