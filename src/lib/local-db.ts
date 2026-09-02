import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { repoFromSourceUrl } from './repo-identity.js';

export interface DecisionRow {
  id: string;
  title: string;
  summary: string;
  sourceUrl: string | null;
  platform: string;
  createdAt: string;
  /** ALI-829: when the decision was MADE, from the source's own timestamp (ISO-8601 Z), as
   *  distinct from `createdAt`, the minute this CLI imported it. Null when the source did not
   *  say - never the ingest minute wearing the wrong name. */
  decidedAt: string | null;
  /** ALI-798: which repo this decision came from (host/owner/repo, or a repo root
   *  path for a remoteless git repo) - null for anything that is not code, or code
   *  whose repo could not be identified. */
  repo: string | null;
}

export interface LinkRow {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  confidence: number;
}

export interface DbStats {
  decisions: number;
  embeddings: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_url TEXT,
  platform TEXT NOT NULL DEFAULT 'cli',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  repo TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS decision_embeddings (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_links (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_refs (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  platform TEXT NOT NULL,
  PRIMARY KEY (decision_id, ref)
);
`;

/**
 * Schema version this build expects. Bump when adding a step to `migrate`.
 *
 * Exported so a test can assert the migration WROTE the version it claims, without hardcoding
 * the number - a test pinning a literal 1 had to be edited by this change rather than passing
 * or failing on its own merits. A parity test also derives the highest `version <` branch in
 * `migrate` from the source and compares it here, because forgetting the bump leaves the new
 * branch running destructively on every open with nothing to stop it.
 */
export const SCHEMA_VERSION = 4;

/**
 * ALI-829: a source timestamp as this database stores it - ISO-8601 Z - or null.
 *
 * Null rather than a fallback: a null date says "unknown", and a plausible wrong date is
 * indistinguishable from a measurement to everything downstream. NaN is checked explicitly
 * because every comparison against NaN is false in both directions, so an unchecked bad
 * date would not error, it would silently vacate whatever filter reads it later
 * (verification.md). A sibling of connector-core's `toIsoOrUndefined`, kept separate on
 * purpose: that one returns undefined for a wire type, this one returns null for a column,
 * and persistence importing a wire helper is the wrong direction. This one is also the
 * stricter of the two (it insists on an ISO date prefix), because it is the last gate
 * before the value is stored.
 */
export function normaliseDecidedAt(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  // Date.parse is lenient in exactly the wrong direction: '12' is December 2001 and
  // '2026' is New Year's Day, both plausible and both wrong. Every producer emits an
  // ISO-8601 instant (git's %aI, the SDK's toIsoOrUndefined), so require that shape.
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const ms = Date.parse(value);
  // Year 0000 parses to a negative instant that Postgres rejects and no source emits.
  if (Number.isNaN(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/** The title connector-core 0.5.0 gave every Slack thread whose root was deleted. The 0.6.0
 *  fetcher titles such a thread from its first human message, or drops it; either way this
 *  row is a duplicate-to-be under the (source_url, title) key, or noise. */
const SLACK_TOMBSTONE_TITLE = 'This message was deleted.';

/**
 * A `source_url` is only an identity if it points at ONE thing. Some fetchers substitute a
 * constant when the per-item link is missing, and connector-core ships one:
 *
 *     dist/fetchers/teams.js:60   source_url: msg.webUrl ?? 'https://teams.microsoft.com'
 *
 * Treating that as an identity is destructive once the column is unique - every such message
 * collapses onto one row. So a bare origin, an empty string and whitespace are normalised to
 * null, which means "no identity" and never collides.
 *
 * Normalised away rather than stored beside a separate identity column: a URL that addresses a
 * host and nothing on it is not a link to the decision, so keeping it would render a
 * "source" link in `align search` that takes the reader to a homepage. One column, one meaning.
 *
 * Deliberately narrow: a URL with any path is treated as identifying, because Confluence's
 * `linkBase`
 * fallback (`https://site.atlassian.net/wiki`) cannot be told apart from a genuinely short page
 * URL, and a hardcoded list of known fallbacks would be wrong the day a fetcher invents one
 * more. That case is caught by the other half of the key instead - uniqueness is on
 * (source_url, title).
 */
export function identifyingSourceUrl(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    // No path, no query, no fragment: this addresses a host, not a thing on it.
    if ((parsed.pathname === '' || parsed.pathname === '/') && !parsed.search && !parsed.hash) {
      return null;
    }
  } catch {
    // Not a parseable URL. `git://commit/<sha>` parses, but an opaque key may not, and an
    // opaque key is still an identity - discarding it would be the destructive direction.
  }
  return value;
}

/**
 * One-time data migrations, tracked in SQLite's built-in `user_version`.
 *
 * 1. ALI-503: relabel the cosine-similarity links that were written as `conflicts_with`.
 *    Every such row at version 0 is provably an artefact, because `insertLink` had exactly
 *    one caller and it hardcoded that relation for any pair over 0.65 cosine. No classifier
 *    verdict was ever persisted, so there is no earned row to damage.
 *
 * 2. A decision's `source_url` identifies it, and nothing enforced that: `insertDecision` minted
 *    a fresh UUID per call, so re-importing the same commit added a second copy. The documented
 *    first run does exactly that - `setup --local` seeds from git, then its own outro tells you
 *    to run `align import git` - so a graph goes from 2 decisions to 4 by following the tips.
 *    Collapse the existing duplicates, then make them unrepresentable with a unique index.
 *
 * 3. ALI-798: add the `repo` column (missing on any graph that predates it) and backfill it
 *    for every existing row from `source_url`, via the same `repoFromSourceUrl` the importer
 *    now stamps new rows with - one reader of the URL shape, used for both. A row whose
 *    source is not code (Jira, Slack, a bare capture) stays NULL, which is "unattributed",
 *    not "wrong": `--repo` scoping always includes unattributed rows alongside the named
 *    repo (see local-gateway-client.ts), so nothing existing becomes invisible.
 *
 * 4. ALI-829: add `decided_at` - when the decision was MADE, from the source's own
 *    timestamp, as distinct from `created_at`, the minute this CLI imported it. Every one
 *    of the 684 rows in the 2026-09-02 measurement carried the ingest minute and nothing
 *    else, so "what changed since March" was unanswerable offline. No backfill, unlike
 *    `repo`: a repo is derivable from a stored source_url, and a decision date is not
 *    derivable from anything already in the row. A re-import fills it in; inventing one
 *    from created_at would write the exact wrong fact this column exists to correct.
 *
 *    Same bump, second step: drop the Slack rows titled by a deleted root. The 0.6.0
 *    fetcher titles a thread from its first human message, and the dedup key is
 *    (source_url, title), so each of those rows would otherwise be re-inserted BESIDE its
 *    tombstone twin on the next import (35 of 39 on the 2026-09-02 graph). The next import
 *    recreates the real ones with real titles; the ones that were only bot output on a
 *    deleted root do not come back, which is the point. Foreign keys are off in this
 *    database (see step 2), so the dependent rows are deleted explicitly - including any
 *    link a human adjudicated on such a row. That is a real loss, accepted: the row's
 *    identity is changing under it, and the re-import classifies the retitled thread
 *    afresh. Scoped to platform = 'slack': a git commit or a captured note that happens to
 *    carry the same words is not a tombstone and is left alone.
 *
 * The version guard is load-bearing rather than tidiness. The same UPDATE run on every open
 * is indistinguishable from this one today, and starts silently eating genuine conflicts the
 * moment anything writes one.
 */
/**
 * Remove a decision and everything hanging off it. Foreign keys are off in this database
 * (see migrate, step 2), so the dependents are named explicitly rather than cascaded. One
 * writer for the v4 tombstone sweep and the ingest-time twin removal (ALI-829).
 */
function deleteDecisionWithDependents(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM decision_links WHERE source_id = ? OR target_id = ?').run(id, id);
  db.prepare('DELETE FROM decision_refs WHERE decision_id = ?').run(id);
  db.prepare('DELETE FROM decision_embeddings WHERE decision_id = ?').run(id);
  db.prepare('DELETE FROM decisions WHERE id = ?').run(id);
}

function migrate(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version < 1) {
    db.exec(`UPDATE decision_links SET relation = 'relates' WHERE relation = 'conflicts_with'`);
  }
  if (version < 2) {
    // IMMEDIATE, not the default DEFERRED: this transaction reads (the survivor scan) before it
    // writes, and under WAL another writer arriving in between makes the first write fail with
    // SQLITE_BUSY_SNAPSHOT, which busy_timeout does not retry. Every local command opens the DB
    // and the advisory hook fires on every agent edit, so a concurrent open is the normal case.
    db.exec('BEGIN IMMEDIATE');
    try {
      // The survivor is the row inserted FIRST. `rowid` rather than `id` breaks a created_at
      // tie: created_at has one-second granularity so rows written in one import tie routinely,
      // and ordering by a random UUID would keep an arbitrary one while this comment claimed to
      // keep the long-standing id. rowid is insertion order (the table is not WITHOUT ROWID).
      //
      // Keyed on (source_url, title), not source_url alone. Some fetchers emit a CONSTANT
      // source_url when the per-item link is missing - connector-core's Teams fallback is
      // literally 'https://teams.microsoft.com' - and collapsing on the URL alone deleted every
      // such message but one. Two rows sharing a URL AND a title are duplicates by any reading;
      // two sharing only the URL are not.
      db.exec(`
        CREATE TEMP TABLE dedup_survivor AS
        SELECT source_url, title, id FROM (
          SELECT source_url, title, id,
                 ROW_NUMBER() OVER (PARTITION BY source_url, title ORDER BY created_at, rowid) AS rn
          FROM decisions WHERE source_url IS NOT NULL
        ) WHERE rn = 1;

        CREATE TEMP TABLE dedup_dropped AS
        SELECT d.id AS id, s.id AS survivor_id
        FROM decisions d JOIN dedup_survivor s
          ON d.source_url = s.source_url AND d.title = s.title
        WHERE d.id <> s.id;
      `);
      // Repoint edges rather than dropping them: an edge naming a duplicate is a real edge that
      // happened to name the copy. Dropping it would lose a relationship the user earned.
      db.exec(`
        UPDATE decision_links SET source_id = (
          SELECT survivor_id FROM dedup_dropped WHERE id = decision_links.source_id
        ) WHERE source_id IN (SELECT id FROM dedup_dropped);
        UPDATE decision_links SET target_id = (
          SELECT survivor_id FROM dedup_dropped WHERE id = decision_links.target_id
        ) WHERE target_id IN (SELECT id FROM dedup_dropped);
      `);
      // Both cleanups are scoped to the pairs repointing actually touched. An earlier version
      // deduplicated decision_links table-wide, which deleted user-earned edges that had nothing
      // to do with duplication - and kept the lowest UUID rather than the highest confidence.
      db.exec(`
        DELETE FROM decision_links
        WHERE source_id = target_id
          AND (source_id IN (SELECT survivor_id FROM dedup_dropped)
            OR target_id IN (SELECT survivor_id FROM dedup_dropped));
      `);
      // Explicitly, not by CASCADE: SQLite leaves foreign_keys OFF unless asked, so the
      // ON DELETE CASCADE in the schema does not fire and these would be orphaned.
      db.exec(`DELETE FROM decision_embeddings WHERE decision_id IN (SELECT id FROM dedup_dropped)`);
      db.exec(`DELETE FROM decisions WHERE id IN (SELECT id FROM dedup_dropped)`);
      db.exec(`DROP TABLE dedup_dropped; DROP TABLE dedup_survivor;`);
      // Created here rather than in SCHEMA on purpose: SCHEMA runs before this function, so on
      // any already-duplicated graph the index would fail to build before the collapse could
      // run. A fresh database passes through the same path with nothing to collapse.
      //
      // A distinct name from any previous attempt, because IF NOT EXISTS matches on the NAME
      // only: an index of the same name with different columns would be silently kept, and
      // every later insert would then fail with "ON CONFLICT clause does not match".
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS decisions_source_title_unique ON decisions(source_url, title)`);
      // Same story for edges: insertLink's `OR IGNORE` was decorative without a unique index, so
      // a re-import stacked an identical relates row every time. Collapse, then constrain.
      //
      // This one IS table-wide, unavoidably: the index cannot be created while any duplicate
      // triple remains anywhere. Every row it removes duplicates another by definition - same
      // source, same target, same relation. It keeps the HIGHEST confidence rather than the
      // lowest uuid, so the survivor is the best score rather than an arbitrary one.
      db.exec(`
        DELETE FROM decision_links WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY source_id, target_id, relation ORDER BY confidence DESC, rowid
            ) AS rn FROM decision_links
          ) WHERE rn = 1
        );
      `);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS decision_links_triple_unique ON decision_links(source_id, target_id, relation)`);
      // Stamped INSIDE the transaction. Outside it, a process killed between COMMIT and the
      // pragma replays the version-1 relabel on the next open, which turns an adjudicated
      // conflicts_with edge into relates - the exact silent loss the docstring above warns of.
      //
      // Stamps this step's OWN number (2), not SCHEMA_VERSION: a later step (3, below) runs
      // after this one commits, and if a crash lands between the two, `user_version` must
      // still read 2 so the version-3 step is not skipped on the next open.
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (err) {
      // Guarded: SQLITE_FULL, IOERR, BUSY, NOMEM and INTERRUPT auto-roll-back, and an
      // unconditional ROLLBACK then throws "no transaction is active" and buries the real
      // cause - so a user whose disk filled mid-migration would be told the wrong thing.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < 3) {
    // The column may already exist: a brand-new database's CREATE TABLE (SCHEMA, above)
    // declares `repo` directly, so on a fresh install this ALTER would fail with "duplicate
    // column name" if run unconditionally. A legacy database predates the column entirely.
    const hasRepoColumn = (db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>)
      .some((c) => c.name === 'repo');
    if (!hasRepoColumn) {
      db.exec('ALTER TABLE decisions ADD COLUMN repo TEXT');
    }
    // Backfill every row with no repo yet. JS-side because SQLite has no regex function to
    // apply `repoFromSourceUrl`'s pattern in SQL - and it must be the SAME function the
    // importer stamps new rows with, or a backfilled row and a freshly-imported one for the
    // same URL could disagree about which repo they belong to.
    const rows = db.prepare('SELECT id, source_url FROM decisions WHERE repo IS NULL')
      .all() as Array<{ id: string; source_url: string | null }>;
    if (rows.length) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const update = db.prepare('UPDATE decisions SET repo = ? WHERE id = ?');
        for (const row of rows) {
          const repo = repoFromSourceUrl(row.source_url);
          // Only WRITE when a repo was found: leaving a non-code row NULL is the correct
          // outcome (unattributed, not "wrong"), and writing NULL over NULL is a no-op
          // this loop can just skip.
          if (repo) update.run(repo, row.id);
        }
        db.exec('PRAGMA user_version = 3');
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
    } else {
      db.exec('PRAGMA user_version = 3');
    }
  }
  if (version < 4) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Same shape as the `repo` step: a fresh database's CREATE TABLE already declares the
      // column, and a legacy one predates it, so the ALTER is conditional. Checked INSIDE
      // the write lock, unlike step 3: two processes opening a v3 file at once (the
      // advisory hook is the normal concurrent case) could otherwise both read "no column"
      // and the second would die on "duplicate column name". SQLite DDL is transactional.
      const hasDecidedAt = (db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>)
        .some((c) => c.name === 'decided_at');
      if (!hasDecidedAt) {
        db.exec('ALTER TABLE decisions ADD COLUMN decided_at TEXT');
      }
      const tombstones = db.prepare(
        `SELECT id FROM decisions WHERE platform = 'slack' AND title = ?`,
      ).all(SLACK_TOMBSTONE_TITLE) as Array<{ id: string }>;
      for (const { id } of tombstones) deleteDecisionWithDependents(db, id);
      // Stamped inside the transaction, for the reason step 2 gives.
      db.exec('PRAGMA user_version = 4');
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

export function createLocalDb(dbPath: string) {
  // SQLite creates the DB file but not its parent directory, so on a clean machine
  // (~/.config/align-cli absent) `align setup --local` crashed with "unable to open
  // database file". Create the directory first. ':memory:' has no parent.
  //
  // Still true after the move off better-sqlite3: node:sqlite does not mkdir either.
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);

  // Shared by insertLink and resolveRefs (ALI-796), so there is one writer of the
  // decision_links insert rather than two copies of the same ON CONFLICT clause.
  function insertLinkRow(link: { sourceId: string; targetId: string; relation: string; confidence: number }): void {
    db.prepare(
      `INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id, target_id, relation)
         DO UPDATE SET confidence = MAX(confidence, excluded.confidence)`
    ).run(randomUUID(), link.sourceId, link.targetId, link.relation, link.confidence);
  }

  return {
    /**
     * Insert, or refresh the decision that already carries this `source_url`, returning the id
     * that now holds it.
     *
     * Refresh rather than ignore: a rewritten commit message or an edited Jira issue should be
     * current in the graph. Returning the EXISTING id on a conflict is what keeps the caller's
     * `setEmbedding` on the surviving row instead of orphaning a vector.
     *
     * A null `source_url` never conflicts - SQLite treats each NULL in a unique index as
     * distinct - so `align capture` with no URL keeps inserting, by construction rather than by
     * a special case here.
     */
    /**
     * `repo` (ALI-798): the identity of the checkout this decision came from, or null for
     * anything that is not code (Jira, Slack, a bare capture). Optional so every existing
     * caller keeps compiling unchanged - omitting it inserts NULL, same as it always did.
     *
     * On a re-import upsert, COALESCE keeps whichever value is non-null: a new repo can fill
     * in an attribution the row did not have, but an already-attributed row is never
     * overwritten back to unattributed by a re-import that (for whatever reason) resolved no
     * repo this time. Re-attributing a row that ALREADY has a (different) repo is not a case
     * this upsert needs to handle - `source_url` identifies the row, and a URL does not
     * change which repo it points at between imports.
     */
    insertDecision(row: {
      title: string; summary: string; sourceUrl: string | null; platform: string; repo?: string | null;
      /** ALI-829: already normalised (normaliseDecidedAt) by the caller, or absent. COALESCE on
       *  the upsert for the same reason `repo` has it: a re-import that resolved no date must
       *  never blank a date the row already carries. */
      decidedAt?: string | null;
    }): string {
      const inserted = db.prepare(
        `INSERT INTO decisions (id, title, summary, source_url, platform, repo, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_url, title) DO UPDATE SET
           summary = excluded.summary, platform = excluded.platform,
           repo = COALESCE(excluded.repo, decisions.repo),
           decided_at = COALESCE(excluded.decided_at, decisions.decided_at)
         RETURNING id`
      ).get(
        randomUUID(),
        row.title,
        row.summary,
        identifyingSourceUrl(row.sourceUrl),
        row.platform,
        row.repo ?? null,
        // `||`, not `??`: COALESCE('', old) is '', so an empty string would blank a stored
        // date. Callers normalise, but this is the one place the column is written.
        row.decidedAt || null,
      ) as { id: string };
      return inserted.id;
    },

    /**
     * The id this graph already holds for `(source_url, title)`, or null.
     *
     * Exists so a caller can tell an insert from a refresh (ALI-770): `insertDecision`
     * upserts and returns the surviving id either way, so an import could not say whether
     * it added anything. It reported every re-import as "Imported N decisions" while the
     * graph did not move, which reads as having imported twice.
     *
     * Normalises through `identifyingSourceUrl` because that is what insertDecision STORES.
     * That function does NOT strip query strings or fragments - it keeps the value verbatim,
     * and only trims whitespace and turns a URL addressing a host and nothing on it into
     * null. (An earlier version of this comment, and of the test beside it, claimed the
     * stripping. The test failed and the claim was wrong; a review bot caught that the
     * comment had kept it.)
     *
     * So what the normalisation buys here is the bare-origin case, and it is the one that
     * matters: connector-core substitutes `https://teams.microsoft.com` for a Teams message
     * with no permalink. Matching on that would find the first such row and report every
     * later Teams message as already known - wrong in the one direction nobody questions,
     * because "0 new" on a real import looks exactly like a no-op the user expected.
     *
     * A null `sourceUrl` is always null here: SQLite treats each NULL in a unique index as
     * distinct, so those rows never conflict and every one of them really is new.
     */
    findIdBySource(sourceUrl: string | null, title: string): string | null {
      const identity = identifyingSourceUrl(sourceUrl);
      if (identity === null) return null;
      const row = db.prepare(
        `SELECT id FROM decisions WHERE source_url = ? AND title = ?`
      ).get(identity, title) as { id: string } | undefined;
      return row?.id ?? null;
    },

    /**
     * `filter.repo` scopes to one repo's rows. `includeUnattributed` (ALI-798's own rule:
     * "repo = ? OR repo IS NULL") also returns rows with no repo at all - a Jira ticket, a
     * Slack thread, anything not code - because a strict `repo = ?` would make 36% of a
     * measured real graph (every non-code decision) invisible from inside any one repo,
     * which is a worse regression than the bug this filter exists to fix. Left false by
     * callers that want an exact match (repo resolution, tests) rather than the retrieval
     * default.
     */
    listDecisions(filter: { repo?: string; includeUnattributed?: boolean } = {}): DecisionRow[] {
      let sql = `SELECT id, title, summary, source_url as sourceUrl, platform, created_at as createdAt, repo, decided_at as decidedAt FROM decisions`;
      const params: string[] = [];
      if (filter.repo !== undefined) {
        sql += filter.includeUnattributed ? ` WHERE (repo = ? OR repo IS NULL)` : ` WHERE repo = ?`;
        params.push(filter.repo);
      }
      sql += ` ORDER BY created_at DESC`;
      return db.prepare(sql).all(...params) as unknown as DecisionRow[];
    },

    getDecisionById(id: string): DecisionRow | null {
      return (db.prepare(
        `SELECT id, title, summary, source_url as sourceUrl, platform, created_at as createdAt, repo, decided_at as decidedAt FROM decisions WHERE id = ?`
      ).get(id) as unknown as DecisionRow | null) ?? null;
    },

    /**
     * ALI-829: drop the tombstone-titled twin of a Slack thread that is being written under
     * a real title. The v4 migration sweeps the tombstones that exist at upgrade time, but a
     * connector-core older than 0.6.0 can still MAKE one afterwards (it titles a thread from
     * its deleted root), and the migration never runs again. So the reconciliation also
     * happens where the retitle happens: the 0.6.0 re-import of the same thread - same
     * source_url, human title - removes the twin it would otherwise sit beside. Idempotent
     * and aimed: only Slack, only this source_url, only the tombstone title. A thread the
     * newer fetcher DROPS (bot output only) is never re-imported and so is never reconciled
     * here; that residue is noise, not a duplicate, and the sweep is what catches it.
     */
    deleteSlackTombstoneTwin(sourceUrl: string | null): void {
      const identity = identifyingSourceUrl(sourceUrl);
      if (identity === null) return;
      const twins = db.prepare(
        `SELECT id FROM decisions WHERE platform = 'slack' AND source_url = ? AND title = ?`,
      ).all(identity, SLACK_TOMBSTONE_TITLE) as Array<{ id: string }>;
      for (const { id } of twins) deleteDecisionWithDependents(db, id);
    },

    /** Distinct repo identities known to this graph, for resolving a `--repo <name>` argument
     *  against what actually exists rather than guessing at a spelling. */
    listRepos(): string[] {
      return (db.prepare(`SELECT DISTINCT repo FROM decisions WHERE repo IS NOT NULL ORDER BY repo`)
        .all() as Array<{ repo: string }>).map((r) => r.repo);
    },

    setEmbedding(decisionId: string, embedding: Float32Array): void {
      db.prepare(
        `INSERT OR REPLACE INTO decision_embeddings (decision_id, embedding) VALUES (?, ?)`
      ).run(decisionId, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
    },

    getEmbedding(decisionId: string): Float32Array | null {
      const row = db.prepare(
        `SELECT embedding FROM decision_embeddings WHERE decision_id = ?`
      ).get(decisionId) as { embedding: Uint8Array } | null;
      if (!row) return null;
      return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    },

    /**
     * Unscoped by default: relationship linking (ingestOne, in local-gateway-client.ts) wants
     * candidates across EVERY repo - cross-repo memory is the product this ticket protects,
     * not just the thing it stops blending on retrieval. A `filter.repo` is for the retrieval
     * paths (search, ask) that DO want to stay in-scope, filtered here rather than after
     * ranking - filtering post-rank would silently return fewer than `topK` results whenever
     * some of the best global matches fall outside the scope.
     */
    getAllEmbeddings(filter: { repo?: string; includeUnattributed?: boolean } = {}): Array<{ decisionId: string; embedding: Float32Array }> {
      let sql = `SELECT e.decision_id, e.embedding FROM decision_embeddings e`;
      const params: string[] = [];
      if (filter.repo !== undefined) {
        sql += ` JOIN decisions d ON d.id = e.decision_id`;
        sql += filter.includeUnattributed ? ` WHERE (d.repo = ? OR d.repo IS NULL)` : ` WHERE d.repo = ?`;
        params.push(filter.repo);
      }
      const rows = db.prepare(sql).all(...params) as Array<{ decision_id: string; embedding: Uint8Array }>;
      return rows.map(r => ({
        decisionId: r.decision_id,
        embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
      }));
    },

    /**
     * `INSERT OR IGNORE` here was decorative: the id is a fresh UUID, so the only key that
     * could conflict was guaranteed not to, and there was no unique index on the triple. With
     * decisions now deduping, a re-import returns the SAME decision id and this added another
     * identical edge every time - measured 1, 2, 3 over three imports, inflating the
     * "similar decisions found" count `align local status` prints.
     *
     * The unique index (created in migrate) is what makes the OR IGNORE real. Confidence is
     * refreshed rather than ignored so a better score replaces a worse one.
     */
    insertLink(link: { sourceId: string; targetId: string; relation: string; confidence: number }): void {
      insertLinkRow(link);
    },

    /**
     * ALI-792: what this decision's text points at (ticket keys, #N, tool URLs).
     * REPLACE semantics, deliberately: insertDecision refreshes the summary on
     * re-import (a rewritten commit message should be current), so the refs derived
     * from that text must follow it - appending would keep refs the text no longer
     * carries, and the gap prompt (ALI-796) would name gaps that no longer exist.
     */
    replaceRefs(decisionId: string, refs: Array<{ ref: string; platform: string }>): void {
      // One transaction, for the same reason migrate() uses one: the advisory hook
      // opens this DB on every agent edit, so a concurrent reader is the normal case
      // and must never observe the refs half-replaced. IMMEDIATE, matching migrate's
      // reasoning about WAL and SQLITE_BUSY_SNAPSHOT.
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`DELETE FROM decision_refs WHERE decision_id = ?`).run(decisionId);
        const insert = db.prepare(
          `INSERT OR IGNORE INTO decision_refs (decision_id, ref, platform) VALUES (?, ?, ?)`
        );
        for (const r of refs) insert.run(decisionId, r.ref, r.platform);
        db.exec('COMMIT');
      } catch (err) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw err;
      }
    },

    getRefs(decisionId: string): Array<{ ref: string; platform: string }> {
      return db.prepare(
        `SELECT ref, platform FROM decision_refs WHERE decision_id = ? ORDER BY rowid`
      ).all(decisionId) as unknown as Array<{ ref: string; platform: string }>;
    },

    /**
     * Every ref across every decision, for the gap resolver (ALI-796): it needs to
     * count DISTINCT decisions per platform graph-wide, which a per-decision
     * `getRefs` cannot do without one round trip per decision.
     */
    getAllRefs(): Array<{ decisionId: string; ref: string; platform: string }> {
      return db.prepare(
        `SELECT decision_id as decisionId, ref, platform FROM decision_refs ORDER BY rowid`
      ).all() as unknown as Array<{ decisionId: string; ref: string; platform: string }>;
    },

    /**
     * ALI-796's payoff: a newly-ingested decision may be the exact thing an EARLIER
     * decision's text already cited (a git commit citing "ALI-123", now that the Jira
     * issue for it has been imported). `candidates` is that new decision's own
     * identity (decision-refs.ts's `refIdentityFor`) - every shape another decision
     * could have recorded it as. For each one that some existing ref already names,
     * link the citer to this decision.
     *
     * Deliberately one-directional: it resolves refs that were ALREADY WAITING when
     * this decision arrives. It does not also re-scan this decision's own text for refs
     * pointing at decisions already in the graph - the realistic setup flow imports git
     * (which writes the citing refs) before a connector is added later to fill them in,
     * so the citer is always the one already present. A source imported before the
     * repo it is later linked from is the case this does not cover.
     *
     * `relation: 'relates'` at confidence 1.0 - not a guess like the cosine-similarity
     * `relates` edges elsewhere (ALI-503): this one is a deterministic exact-key match,
     * and 1.0 says so. `insertLinkRow`'s unique index on (source, target, relation)
     * makes re-resolving the same pair on a later import a no-op rather than a
     * duplicate edge.
     */
    resolveRefs(newDecisionId: string, candidates: Array<{ ref: string; platform: string }>): void {
      if (!candidates.length) return;
      const findCiters = db.prepare(
        `SELECT decision_id as decisionId FROM decision_refs WHERE platform = ? AND ref = ? AND decision_id != ?`
      );
      for (const c of candidates) {
        const citers = findCiters.all(c.platform, c.ref, newDecisionId) as Array<{ decisionId: string }>;
        for (const citer of citers) {
          insertLinkRow({ sourceId: citer.decisionId, targetId: newDecisionId, relation: 'relates', confidence: 1.0 });
        }
      }
    },

    listLinks(filter?: { relation?: string; decisionId?: string }): LinkRow[] {
      let sql = `SELECT id, source_id as sourceId, target_id as targetId, relation, confidence FROM decision_links WHERE 1=1`;
      const params: string[] = [];
      if (filter?.relation) { sql += ` AND relation = ?`; params.push(filter.relation); }
      if (filter?.decisionId) { sql += ` AND (source_id = ? OR target_id = ?)`; params.push(filter.decisionId, filter.decisionId); }
      return db.prepare(sql).all(...params) as unknown as LinkRow[];
    },

    getStats(): DbStats {
      const decisions = (db.prepare(`SELECT COUNT(*) as n FROM decisions`).get() as { n: number }).n;
      const embeddings = (db.prepare(`SELECT COUNT(*) as n FROM decision_embeddings`).get() as { n: number }).n;
      // ALI-503 removed a `conflicts` count here: it had no production reader (only a test)
      // and after the relabelling it could only ever report 0, which is a decoy.
      return { decisions, embeddings };
    },

    dropAll(): void {
      // decision_refs listed explicitly: SQLite leaves foreign_keys OFF unless asked,
      // so the schema's ON DELETE CASCADE never fires (same fact the v2 migration
      // documents above).
      db.exec(`DELETE FROM decision_refs; DELETE FROM decision_links; DELETE FROM decision_embeddings; DELETE FROM decisions;`);
    },

    close(): void {
      db.close();
    },
  };
}

export type LocalDb = ReturnType<typeof createLocalDb>;
