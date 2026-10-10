import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deleteDecisionWithDependents, migrate, SCHEMA, SLACK_TOMBSTONE_TITLE } from './local-db-migrate.js';
import type { DeciderKind } from './decider-kind.js';
import { foldKeylessTwin } from './local-db-v7.js';
import { connectorItemKey, KEYED_PLATFORMS } from './source-key.js';

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
  /** ALI-831: which kind of actor decided. Null for a row captured before the column
   *  existed - read as 'unknown', never backfilled (see migrate, step 5). */
  deciderKind: DeciderKind | null;
  /** ALI-831: "this was said" - the two flags are separate acts (Tom, 2026-09-03). Confirm
   *  is written by the session importer (ALI-808); ratify is the human act below. */
  confirmedBy: string | null;
  confirmedAt: string | null;
  /** ALI-831: "this governs". Set once by `align ratify`; the first ratification stands. */
  ratifiedBy: string | null;
  ratifiedAt: string | null;
}

export interface AuditRow {
  id: string;
  decisionId: string;
  action: string;
  actor: string | null;
  detail: string | null;
  createdAt: string;
}

export interface LinkRow {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  confidence: number;
  /** ALI-1087: when the edge itself was recorded, distinct from either endpoint's own
   *  `createdAt`. An as-of query has to bound both separately - the two decisions can
   *  predate a cutoff while the edge asserting a relation between them was written after
   *  it, and a relation nobody had recorded yet is not one the as-of answer may use. */
  createdAt: string;
}

export interface DbStats {
  decisions: number;
  embeddings: number;
}

export { SCHEMA_VERSION } from './local-db-migrate.js';

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
  // `<= 0`, deliberately including the epoch itself: 1970-01-01T00:00:00Z is what an unset
  // numeric timestamp renders as (a zeroed field, a Slack `ts` of '0'), so it is the one
  // date most likely to be a fabrication with a plausible face - connector-core's
  // toIsoOrUndefined rejects it for the same reason. Year 0000 is the negative case
  // Postgres rejects outright. No real decision was made at either instant.
  if (Number.isNaN(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

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

/** Every column a DecisionRow carries, aliased to its camelCase name. One writer, read by
 *  both row readers, so a new column cannot be added to one SELECT and missed by the other. */
const DECISION_COLUMNS =
  'id, title, summary, source_url as sourceUrl, platform, created_at as createdAt, repo, decided_at as decidedAt, ' +
  'decider_kind as deciderKind, confirmed_by as confirmedBy, confirmed_at as confirmedAt, ' +
  'ratified_by as ratifiedBy, ratified_at as ratifiedAt';

/** A person's ratification or confirmation covers the text they read (review finding 4). */
const ATTESTED = 'decisions.ratified_at IS NOT NULL OR decisions.confirmed_at IS NOT NULL';

/** L3: an items-first arrival (excluded.detail_pending) onto a row that already holds its
 *  discussion (decisions.detail_pending = 0) carries LESS text than the row. Keep the row. */
const KEEP_RICHER = '(excluded.detail_pending = 1 AND decisions.detail_pending = 0)';

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
  // 30s: the longest measured v7 migration (100k rows, 33k merges) takes about 5s, so a waiting
  // opener outlasts it with margin. First, before anything that needs a lock: every local command and the advisory hook open
  // this file, so a concurrent opener is normal, and without a timeout it fails at once with
  // "database is locked" instead of waiting for the migration in progress.
  db.exec('PRAGMA busy_timeout = 30000');
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  // Shared by insertLink and resolveRefs (ALI-796), so there is one writer of the
  // decision_links insert rather than two copies of the same ON CONFLICT clause.
  function insertLinkRow(link: { sourceId: string; targetId: string; relation: string; confidence: number }): void {
    db.prepare(
      `INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id, target_id, relation)
         DO UPDATE SET confidence = MAX(confidence, excluded.confidence)`
    ).run(randomUUID(), link.sourceId, link.targetId, link.relation, link.confidence);
  }

  const api = {
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
      /** ALI-831: who decided. Set on INSERT and never rewritten by the upsert - origin is
       *  immutable, so a human re-capture cannot launder an agent claim into 'human' (the
       *  cloud's snapshots.ts rule). Omitted stores NULL, which reads as 'unknown'. */
      deciderKind?: DeciderKind | null;
      /** L2: true ONLY from connector import code. Gives a one-item-per-URL item its source_key,
       *  so an edited title updates the row. Never inferred from the platform: `align capture
       *  <PR url>` stamps `github` too, and must not merge with the imported item. */
      keyed?: boolean;
      /** L3: the item arrived items-first (GitHub `discussion: 'none'`): its discussion has not
       *  been fetched. Stored in `detail_pending` so the later drain can find it. A pending
       *  arrival never downgrades a row whose discussion is already stored (see the upsert). */
      detailPending?: boolean;
    }): string {
      // L2: a one-item-per-URL connector item upserts on its source_key, and that branch takes
      // the new title, so an edited PR title updates the row instead of adding a twin. Every
      // other row (sessions, captures, docs) keeps the (source_url, title) identity.
      //
      // Both branches clear enriched_at: the row's text may have changed, so its links are not
      // known to be current until ingestOne's link pass marks it again (Decision 30).
      const sourceUrl = identifyingSourceUrl(row.sourceUrl);
      const key = (row.keyed ? connectorItemKey(row.platform, sourceUrl) : undefined) ?? null;
      api.foldPendingTwin(sourceUrl, row.title, row.platform, row.keyed);
      const inserted = db.prepare(
        `INSERT INTO decisions (id, title, summary, source_url, platform, repo, decided_at, decider_kind, source_key, detail_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_key) WHERE source_key IS NOT NULL DO UPDATE SET
           title = CASE WHEN ${ATTESTED} OR ${KEEP_RICHER} THEN decisions.title ELSE excluded.title END,
           summary = CASE WHEN ${ATTESTED} OR ${KEEP_RICHER} THEN decisions.summary ELSE excluded.summary END,
           platform = excluded.platform,
           repo = COALESCE(excluded.repo, decisions.repo),
           decided_at = COALESCE(excluded.decided_at, decisions.decided_at),
           detail_pending = CASE WHEN ${KEEP_RICHER} THEN 0 ELSE excluded.detail_pending END,
           enriched_at = CASE WHEN ${ATTESTED} THEN decisions.enriched_at ELSE NULL END
         ON CONFLICT(source_url, title) DO UPDATE SET
           summary = excluded.summary, platform = excluded.platform,
           repo = COALESCE(excluded.repo, decisions.repo),
           decided_at = COALESCE(excluded.decided_at, decisions.decided_at),
           enriched_at = NULL
         RETURNING id`
      ).get(
        randomUUID(),
        row.title,
        row.summary,
        sourceUrl,
        row.platform,
        row.repo ?? null,
        // `||`, not `??`: COALESCE('', old) is '', so an empty string would blank a stored
        // date. Callers normalise, but this is the one place the column is written.
        row.decidedAt || null,
        row.deciderKind ?? null,
        key,
        row.detailPending ? 1 : 0,
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
    findIdBySource(sourceUrl: string | null, title: string, platform?: string, keyed?: boolean): string | null {
      const identity = identifyingSourceUrl(sourceUrl);
      if (identity === null) return null;
      // L2: with the platform, a one-item-per-URL item is found by its source_key, so a retitled
      // PR is recognised as the row insertDecision is about to update, not as a new one.
      const key = platform === undefined || !keyed ? undefined : connectorItemKey(platform, identity);
      if (key !== undefined) {
        const byKey = db.prepare(`SELECT id FROM decisions WHERE source_key = ?`).get(key) as { id: string } | undefined;
        if (byKey) return byKey.id;
      }
      const row = db.prepare(
        `SELECT id FROM decisions WHERE source_url = ? AND title = ?`
      ).get(identity, title) as { id: string } | undefined;
      return row?.id ?? null;
    },

    /**
     * Review finding 4: what a keyed re-import may write over row `id`. A ratified or confirmed
     * row keeps the text a person attested; the incoming text is recorded once as a
     * `text_revision_pending` audit note and the stored text is returned. Any other row (or an
     * unknown id) gets the incoming text back unchanged.
     */
    keepProtectedText(id: string, title: string, summary: string): { title: string; summary: string } {
      const row = db.prepare(`SELECT title, summary, ratified_at, confirmed_at FROM decisions WHERE id = ?`).get(id) as
        { title: string; summary: string; ratified_at: string | null; confirmed_at: string | null } | undefined;
      if (!row || (row.ratified_at === null && row.confirmed_at === null)) return { title, summary };
      if (row.title !== title || row.summary !== summary) {
        const detail = JSON.stringify({ title, summary });
        const seen = db.prepare(`SELECT 1 AS hit FROM decision_audit WHERE decision_id = ? AND action = 'text_revision_pending' AND detail = ?`).get(id, detail);
        if (!seen) {
          api.insertAudit({ decisionId: id, action: 'text_revision_pending', actor: null, detail });
          // Bounded: an upstream that changes every sync would otherwise add a row per sync.
          db.prepare(`DELETE FROM decision_audit WHERE decision_id = ? AND action = 'text_revision_pending' AND rowid NOT IN
            (SELECT rowid FROM decision_audit WHERE decision_id = ? AND action = 'text_revision_pending' ORDER BY rowid DESC LIMIT 5)`).run(id, id);
        }
      }
      return { title: row.title, summary: row.summary };
    },

    /** The id of the connector-imported item `url` names, under any platform, or null. A capture
     *  of that URL must not rewrite the imported text (L2 review finding 1). */
    findKeyedIdByUrl(url: string): string | null {
      const identity = identifyingSourceUrl(url);
      if (identity === null) return null;
      for (const platform of KEYED_PLATFORMS) {
        const key = connectorItemKey(platform, identity);
        const hit = key === undefined ? undefined : db.prepare(`SELECT id FROM decisions WHERE source_key = ?`).get(key) as { id: string } | undefined;
        if (hit) return hit.id;
      }
      return null;
    },

    /**
     * A keyless row at this (source_url, title) is a twin an older binary wrote beside the keyed
     * one. Adopt it as the keyed row, or fold it with the row that already holds the key (the
     * attested one survives). ingestOne calls this BEFORE it looks the item up, so the text it
     * protects and embeds is the survivor's. No-op for an unkeyed call.
     */
    foldPendingTwin(sourceUrl: string | null, title: string, platform: string, keyed?: boolean): void {
      const key = keyed ? connectorItemKey(platform, sourceUrl) : undefined;
      if (key === undefined) return;
      const twin = db.prepare(`SELECT id FROM decisions WHERE source_url = ? AND title = ? AND source_key IS NULL`).get(sourceUrl, title) as { id: string } | undefined;
      if (!twin) return;
      const holder = db.prepare(`SELECT id FROM decisions WHERE source_key = ?`).get(key) as { id: string } | undefined;
      if (holder) foldKeylessTwin(db, twin.id, holder.id, key);
      else db.prepare(`UPDATE decisions SET source_key = ? WHERE id = ?`).run(key, twin.id);
    },

    /** A capture of a URL a connector already imported: audit it, change nothing, return the row. */
    noteCaptureOfHeldItem(url: string): DecisionRow | null {
      const id = api.findKeyedIdByUrl(url);
      const row = id === null ? null : api.getDecisionById(id);
      const today = id === null ? undefined : db.prepare(`SELECT 1 AS hit FROM decision_audit WHERE decision_id = ? AND action = 'capture_seen' AND date(created_at) = date('now')`).get(id);
      if (row && !today) api.insertAudit({ decisionId: row.id, action: 'capture_seen', actor: null, detail: url });
      return row;
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
    listDecisions(filter: { repo?: string; includeUnattributed?: boolean; unratified?: boolean } = {}): DecisionRow[] {
      let sql = `SELECT ${DECISION_COLUMNS} FROM decisions`;
      const where: string[] = [];
      const params: string[] = [];
      if (filter.repo !== undefined) {
        where.push(filter.includeUnattributed ? `(repo = ? OR repo IS NULL)` : `repo = ?`);
        params.push(filter.repo);
      }
      // ALI-831: the human queue. Both predicates, because "unratified" alone would list every
      // human decision ever captured (nothing ratifies those) and the queue would be useless.
      if (filter.unratified) where.push(`decider_kind = 'agent' AND ratified_at IS NULL`);
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ` ORDER BY created_at DESC`;
      return db.prepare(sql).all(...params) as unknown as DecisionRow[];
    },

    getDecisionById(id: string): DecisionRow | null {
      return (db.prepare(
        `SELECT ${DECISION_COLUMNS} FROM decisions WHERE id = ?`
      ).get(id) as unknown as DecisionRow | null) ?? null;
    },

    /**
     * ALI-831: the human act. Writes both columns in one statement guarded by
     * `ratified_at IS NULL`, so the first ratification stands and a concurrent second caller
     * sees null rather than overwriting it - the same first-wins rule as the cloud's
     * ratifyDecision use case. Null for a missing id too; the caller tells the two apart by
     * reading the row, and neither is a write.
     */
    markRatified(id: string, ratifiedBy: string): { ratifiedAt: string } | null {
      const ratifiedAt = new Date().toISOString();
      const row = db.prepare(
        `UPDATE decisions SET ratified_by = ?, ratified_at = ?
         WHERE id = ? AND ratified_at IS NULL
         RETURNING ratified_at AS ratifiedAt`,
      ).get(ratifiedBy, ratifiedAt, id) as { ratifiedAt: string } | undefined;
      return row ?? null;
    },

    /**
     * ALI-808: "this was said" - the session importer's act, written once at the moment a
     * human accepts a session-derived candidate into the graph (confirm-each). The columns
     * were reserved for this by ALI-831 (see DecisionRow's own doc), which landed first;
     * this is the one write path for them. No first-wins guard: unlike ratify there is no
     * later racing caller to protect against - the importer calls this exactly once, right
     * after the insert it just made. A missing id updates zero rows and returns null, same
     * as markRatified.
     */
    markConfirmed(id: string, confirmedBy: string): { confirmedAt: string } | null {
      const confirmedAt = new Date().toISOString();
      const row = db.prepare(
        `UPDATE decisions SET confirmed_by = ?, confirmed_at = ?
         WHERE id = ?
         RETURNING confirmed_at AS confirmedAt`,
      ).get(confirmedBy, confirmedAt, id) as { confirmedAt: string } | undefined;
      return row ?? null;
    },

    /**
     * L2, Decision 30: the decision's ingest finished, link pass included. ingestOne is the one
     * caller, and calls it as its last write; insertDecision clears it whenever it rewrites the
     * row. NULL therefore means "links not known to be current", and the unchanged-skip will
     * not skip such a row.
     */
    markEnriched(id: string): void {
      db.prepare(`UPDATE decisions SET enriched_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
    },

    getEnrichedAt(id: string): string | null {
      const row = db.prepare(`SELECT enriched_at AS e FROM decisions WHERE id = ?`).get(id) as { e: string | null } | undefined;
      return row?.e ?? null;
    },

    /** ALI-831: one row per human act on a decision (ratified, pushed), so "who stood behind
     *  this, and when" is answerable after the fact. Append-only by construction. */
    insertAudit(entry: { decisionId: string; action: string; actor: string | null; detail?: string | null }): void {
      db.prepare(
        `INSERT INTO decision_audit (id, decision_id, action, actor, detail) VALUES (?, ?, ?, ?, ?)`,
      ).run(randomUUID(), entry.decisionId, entry.action, entry.actor, entry.detail ?? null);
    },

    listAudit(decisionId: string): AuditRow[] {
      return db.prepare(
        `SELECT id, decision_id AS decisionId, action, actor, detail, created_at AS createdAt
         FROM decision_audit WHERE decision_id = ? ORDER BY rowid`,
      ).all(decisionId) as unknown as AuditRow[];
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

    /** How many GIT decisions carry this repo stamp. A setup re-run asks before re-scanning
     *  git, so the graph rather than a memory of the last run decides. Git rows only: every
     *  hosted code URL stamps its repo (a PR captured by hand is still code), and a graph
     *  holding twelve PRs and no commits has not had its history scanned. */
    gitDecisionCount(repo: string): number {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE repo = ? AND platform = 'git'`).get(repo) as { n: number };
      return row.n;
    },

    /** Whether any repo-docs row (an ADR, a CLAUDE.md section) came from this repo. Docs rows
     *  carry no repo stamp, because a blob URL is not a commit/pull/issue URL, so this reads
     *  the URL the docs importer builds: <host>/<owner>/<repo>/blob/... on GitHub and
     *  <host>/<owner>/<repo>/-/blob/... on GitLab. The slashes on both sides keep `o/r` from
     *  matching `xo/r` or `o/r2`; `_` and `%` are escaped because LIKE reads them as wildcards.
     *  A repo with no hosted remote writes git://blob/... URLs that name no repo, so the answer
     *  there is no, and its docs are re-read (a few files, idempotent). Case-insensitive, as
     *  repo identities are. */
    hasDocsForRepo(repo: string): boolean {
      const literal = repo.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
      const row = db.prepare(
        `SELECT 1 AS hit FROM decisions WHERE platform = 'docs'
           AND (lower(source_url) LIKE '%/' || ? || '/blob/%' ESCAPE '\\'
             OR lower(source_url) LIKE '%/' || ? || '/-/blob/%' ESCAPE '\\') LIMIT 1`,
      ).get(literal, literal) as { hit: number } | undefined;
      return row !== undefined;
    },

    /**
     * ALI-787: `model` tags which HF model produced `embedding`, so a future model swap
     * cannot compare two models' vectors as if they were interchangeable - same-length
     * float arrays from different models pass cosineSimilarity's length check and produce a
     * plausible, meaningless score with nothing to catch it (see local-embeddings.ts,
     * cosineSimilarity's own doc comment, for the sibling case this closes: a length
     * mismatch throws, but a same-length cross-model comparison would not have).
     *
     * Optional and defaulting to NULL (`?? null`, since node:sqlite throws on a bound
     * `undefined` rather than treating it as NULL) so every existing 2-arg caller keeps
     * compiling and behaving exactly as before. The one production caller
     * (local-gateway-client.ts's ingestOne) always passes EMBEDDING_MODEL_ID.
     */
    setEmbedding(decisionId: string, embedding: Float32Array, model?: string): void {
      db.prepare(
        `INSERT OR REPLACE INTO decision_embeddings (decision_id, embedding, model) VALUES (?, ?, ?)`
      ).run(decisionId, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), model ?? null);
    },

    getEmbedding(decisionId: string): Float32Array | null {
      const row = db.prepare(
        `SELECT embedding FROM decision_embeddings WHERE decision_id = ?`
      ).get(decisionId) as { embedding: Uint8Array } | null;
      if (!row) return null;
      return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    },

    /** ALI-787: which model tagged this decision's stored embedding, or null when there is
     *  no embedding row, or the row predates tagging and was never backfilled (should not
     *  happen post-migration, but reads as "unknown" rather than a false match either way). */
    getEmbeddingModel(decisionId: string): string | null {
      const row = db.prepare(
        `SELECT model FROM decision_embeddings WHERE decision_id = ?`
      ).get(decisionId) as { model: string | null } | undefined;
      return row?.model ?? null;
    },

    /**
     * Unscoped by default: relationship linking (ingestOne, in local-gateway-client.ts) wants
     * candidates across EVERY repo - cross-repo memory is the product this ticket protects,
     * not just the thing it stops blending on retrieval. A `filter.repo` is for the retrieval
     * paths (search, ask) that DO want to stay in-scope, filtered here rather than after
     * ranking - filtering post-rank would silently return fewer than `topK` results whenever
     * some of the best global matches fall outside the scope.
     *
     * ALI-787: `filter.model`, when given, excludes rows tagged with a DIFFERENT (non-null)
     * model - the "degrade honestly" half of the model tag: a decision embedded by a retired
     * model drops out of ranking rather than being compared to a current-model vector it is
     * not compatible with. A NULL-tagged row (no model recorded at all) is treated as
     * compatible rather than excluded, the same "unknown, not wrong" leniency checkDrift
     * applies to a single decision - the migration backfills every pre-existing row, so NULL
     * should not occur in a real graph, and this is what keeps a hand-built test fixture that
     * predates ALI-787 (a bare 2-arg setEmbedding) behaving as it always did. Omitted (the
     * default) applies no filter at all, which is what most existing callers and tests rely
     * on - only local-gateway-client.ts's findSimilar passes it, with the currently active
     * EMBEDDING_MODEL_ID.
     */
    /**
     * ALI-1087: `createdBefore` excludes any decision whose OWN `created_at` is at or after
     * the cutoff, so an as-of query never ranks a candidate that did not exist yet at that
     * moment. Joins `decisions` whenever either it or `repo` is set - both need the same
     * table, and joining twice would be a second writer of the same predicate.
     *
     * `julianday(...)`, not a raw string compare (Copilot, #320). `d.created_at` is written
     * ONLY by SQLite's own `datetime('now')` default - 'YYYY-MM-DD HH:MM:SS', a space, no
     * offset - while `createdBefore` is validated as an ISO-8601 instant with a 'T' and an
     * offset/Z. On any date the two share, ' ' (0x20) sorts before 'T' (0x54) regardless of
     * the actual clock time, so `d.created_at < ?` as plain TEXT would call every decision
     * captured LATER on the cutoff's own calendar day "before" it. `julianday()` parses both
     * formats (SQLite treats a bare space-separated datetime as UTC, which matches what
     * `datetime('now')` writes) into a real instant before comparing.
     */
    getAllEmbeddings(filter: { repo?: string; includeUnattributed?: boolean; model?: string; createdBefore?: string } = {}): Array<{ decisionId: string; embedding: Float32Array }> {
      let sql = `SELECT e.decision_id, e.embedding FROM decision_embeddings e`;
      const where: string[] = [];
      const params: string[] = [];
      if (filter.repo !== undefined || filter.createdBefore !== undefined) {
        sql += ` JOIN decisions d ON d.id = e.decision_id`;
      }
      if (filter.repo !== undefined) {
        where.push(filter.includeUnattributed ? `(d.repo = ? OR d.repo IS NULL)` : `d.repo = ?`);
        params.push(filter.repo);
      }
      if (filter.createdBefore !== undefined) {
        where.push(`julianday(d.created_at) < julianday(?)`);
        params.push(filter.createdBefore);
      }
      if (filter.model !== undefined) {
        where.push(`(e.model = ? OR e.model IS NULL)`);
        params.push(filter.model);
      }
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
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
     * ALI-1065: a pair gets ONE edge, never two. `insertLinkRow`'s unique index is on
     * (source_id, target_id, relation), so writing `supersedes` for a pair that already
     * carries a `relates` row for the SAME pair does not collide - it appends a second
     * row, and a reader would see both. This deletes any existing edge between the pair
     * (either direction, any relation) before writing the new one, so capture-time
     * classification can upgrade a cosine `relates` edge into a typed one atomically.
     */
    replaceLink(link: { sourceId: string; targetId: string; relation: string; confidence: number }): void {
      db.prepare(
        'DELETE FROM decision_links WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)',
      ).run(link.sourceId, link.targetId, link.targetId, link.sourceId);
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

    /**
     * ALI-1087: `createdBefore` bounds the edge itself to what existed as of that instant.
     * `julianday(...)`, not a raw string compare - `created_at` is written only by SQLite's
     * `datetime('now')` default, in the same space-separated, offset-less format that makes
     * a plain TEXT comparison against an ISO cutoff wrong on the cutoff's own calendar day
     * (see `getAllEmbeddings`'s doc comment for the mechanism).
     */
    listLinks(filter?: { relation?: string; decisionId?: string; createdBefore?: string }): LinkRow[] {
      let sql = `SELECT id, source_id as sourceId, target_id as targetId, relation, confidence, created_at as createdAt FROM decision_links WHERE 1=1`;
      const params: string[] = [];
      if (filter?.relation) { sql += ` AND relation = ?`; params.push(filter.relation); }
      if (filter?.decisionId) { sql += ` AND (source_id = ? OR target_id = ?)`; params.push(filter.decisionId, filter.decisionId); }
      if (filter?.createdBefore) { sql += ` AND julianday(created_at) < julianday(?)`; params.push(filter.createdBefore); }
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
  return api;
}

export type LocalDb = ReturnType<typeof createLocalDb>;
