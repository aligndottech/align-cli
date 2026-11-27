/**
 * Additive, idempotent repair for local graphs imported before #700 from a port-bearing GitHub
 * remote (e.g. ssh://git@ssh.github.com:443/owner/repo.git).
 *
 * Before #700 dropped the port in remote-url.ts, buildCommitUrl, buildBlobUrl and repoFromRemoteUrl
 * kept the port as a leading path segment:
 *   repo       = github.com/443/owner/repo
 *   source_url = https://github.com/443/owner/repo/commit/<sha> (or .../blob/...)
 *   source_key = git|https://github.com/443/owner/repo/commit/<sha>
 *
 * Once #700 fixed new imports to write github.com/owner/repo, repo-scoped queries missed every
 * pre-0.92.0 row and re-running `align connect git` or `align connect docs` inserted duplicate
 * clean rows beside them.
 *
 * Safety rules:
 * - On GitHub a real repository always has exactly two path segments (`owner/repo`), never three,
 *   so `github.com/<port>/<owner>/<repo>` (port 1..65535) never collides with a legitimate
 *   all-digit GitHub owner like `github.com/1234/repo`.
 * - GitLab allows all-digit top-level group paths (`gitlab.com/443`) and nested subgroups, so
 *   `gitlab.com/443/team/project` cannot be distinguished from a leaked port in stored rows alone;
 *   offline repair leaves GitLab rows untouched for `connect git` where the real remote is known.
 * - When a clean row already exists (from a post-#700 re-import), both rows are folded through
 *   foldTwins so attestations, links, refs, judgements and backups stay intact without hitting
 *   unique constraints on source_key or (source_url, title).
 */
import type { DatabaseSync } from 'node:sqlite';
import { bumpRowSetEpoch } from './local-db-epoch.js';
import { foldTwins, type TwinRow } from './local-db-v7.js';
import { refIdentityFor } from './decision-refs.js';
import { linkByReference } from './local-ref-links.js';
import { repoFromSourceUrl } from './repo-identity.js';
import { connectorItemKey } from './source-key.js';

const GITHUB_PORT_URL = /^https:\/\/github\.com\/([1-9]\d{0,4})\/([^/\s]+\/[^/\s]+)\/(commit|blob)\/(.+)$/i;
const GITHUB_PORT_REPO = /^github\.com\/([1-9]\d{0,4})\/([^/\s]+\/[^/\s]+)$/i;

const TWIN_COLUMNS = 'id, rowid, created_at, title, summary, ratified_by, ratified_at, confirmed_by, confirmed_at';

function isValidPort(raw: string): boolean {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Rewritten URL with the leaked port segment removed, or null when the URL is not affected. */
export function stripPortFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const gh = GITHUB_PORT_URL.exec(url);
  if (gh && isValidPort(gh[1]!)) return `https://github.com/${gh[2]}/${gh[3]}/${gh[4]}`;
  return null;
}

/** Rewritten repo identity with the leaked port segment removed, or null when not affected. */
export function stripPortFromRepo(repo: string | null | undefined): string | null {
  if (!repo) return null;
  const gh = GITHUB_PORT_REPO.exec(repo);
  if (gh && isValidPort(gh[1]!)) return `github.com/${gh[2]!.toLowerCase()}`;
  return null;
}

interface CandidateRow {
  id: string;
  title: string;
  summary: string;
  source_url: string | null;
  platform: string;
  repo: string | null;
  source_key: string | null;
}

function findCandidates(db: DatabaseSync): CandidateRow[] {
  return db.prepare(
    `SELECT id, title, summary, source_url, platform, repo, source_key
     FROM decisions
     WHERE platform IN ('git', 'docs')
       AND (
         repo LIKE 'github.com/%/%/%'
         OR source_url LIKE 'https://github.com/%/%/%/%'
       )
     ORDER BY rowid`,
  ).all() as unknown as CandidateRow[];
}

// A URL alone cannot prove a leak (github.com/1234/widgets/blob/blob/x reads as port/owner/repo), so only rows whose stored repo carries the port segment are repaired.
function isLeaked(row: CandidateRow): boolean {
  return stripPortFromRepo(row.repo) !== null;
}

function hasAffectedCoChange(db: DatabaseSync): boolean {
  const exists = db.prepare(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'co_change_rules'`).get();
  if (!exists) return false;
  const rows = db.prepare(`SELECT DISTINCT repo FROM co_change_rules WHERE repo LIKE 'github.com/%/%/%'`)
    .all() as Array<{ repo: string | null }>;
  return rows.some((r) => stripPortFromRepo(r.repo) !== null);
}

// decision_identities were derived from the port-bearing URL before this repair, so re-derive them (and link any citer) from the clean one.
function refreshIdentities(db: DatabaseSync, id: string, platform: string, url: string | null): void {
  linkByReference(db, id, refIdentityFor(platform, url));
}

function replaceSummaryUrl(summary: string, oldUrl: string, nextUrl: string): string {
  const needle = `URL: ${oldUrl}`;
  return summary.includes(needle) ? summary.replace(needle, `URL: ${nextUrl}`) : summary;
}

/**
 * Repair pre-#700 port-prefixed git/docs rows and co-change rules in place.
 * Fast path: returns without taking a write lock when no affected rows exist.
 */
export function repairPortPrefixedRepos(db: DatabaseSync): void {
  const preview = findCandidates(db).filter(isLeaked);
  const coChangeDirty = hasAffectedCoChange(db);
  if (preview.length === 0 && !coChangeDirty) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read inside the write lock so two concurrent openers never double-migrate.
    const rows = findCandidates(db);
    let touched = false;
    for (const row of rows) {
      if (!isLeaked(row)) continue;
      const nextUrl = stripPortFromUrl(row.source_url) ?? row.source_url;
      const nextRepo = (nextUrl ? repoFromSourceUrl(nextUrl) : null) ?? stripPortFromRepo(row.repo) ?? row.repo;
      const nextKey = row.source_key !== null && nextUrl
        ? (connectorItemKey(row.platform, nextUrl) ?? null)
        : row.source_key;
      if (nextUrl === row.source_url && nextRepo === row.repo && nextKey === row.source_key) continue;
      touched = true;

      const holderIds = new Set<string>();
      if (nextKey !== null) {
        const byKey = db.prepare('SELECT id FROM decisions WHERE source_key = ? AND id <> ?').get(nextKey, row.id) as { id: string } | undefined;
        if (byKey) holderIds.add(byKey.id);
      }
      if (nextUrl !== null) {
        const byUrlTitle = db.prepare('SELECT id FROM decisions WHERE source_url = ? AND title = ? AND id <> ?').get(nextUrl, row.title, row.id) as { id: string } | undefined;
        if (byUrlTitle) holderIds.add(byUrlTitle.id);
      }

      if (holderIds.size === 0) {
        const nextSummary = row.source_url && nextUrl && nextUrl !== row.source_url
          ? replaceSummaryUrl(row.summary, row.source_url, nextUrl)
          : row.summary;
        db.prepare('UPDATE decisions SET source_url = ?, repo = ?, source_key = ?, summary = ? WHERE id = ?')
          .run(nextUrl, nextRepo, nextKey, nextSummary, row.id);
        refreshIdentities(db, row.id, row.platform, nextUrl);
        continue;
      }

      const preferred = [...holderIds][0]!;
      // A legacy row with no key must not wipe the key its clean twin holds. Read that key before the fold,
      // which may delete the twin; the survivor update below writes it back.
      const twinKey = db.prepare(`SELECT source_key FROM decisions WHERE id IN (${[...holderIds].map(() => '?').join(', ')}) AND source_key IS NOT NULL ORDER BY rowid`)
        .get(...holderIds) as { source_key: string } | undefined;
      const survivorKey = nextKey ?? twinKey?.source_key ?? null;
      const ids = [row.id, ...holderIds];
      const placeholders = ids.map(() => '?').join(', ');
      const twins = db.prepare(`SELECT ${TWIN_COLUMNS} FROM decisions WHERE id IN (${placeholders}) ORDER BY rowid`)
        .all(...ids) as unknown as TwinRow[];
      foldTwins(db, twins, nextKey, 'migration', preferred);
      // If an attested old row survived, foldTwins intentionally preserves its text/summary,
      // so rewrite its source_url, repo, source_key and any embedded URL: line to the clean values.
      const survivor = db.prepare(`SELECT id, summary FROM decisions WHERE id IN (${placeholders})`).get(...ids) as { id: string; summary: string } | undefined;
      if (survivor) {
        const survivorSummary = row.source_url && nextUrl && nextUrl !== row.source_url
          ? replaceSummaryUrl(survivor.summary, row.source_url, nextUrl)
          : survivor.summary;
        db.prepare('UPDATE decisions SET source_url = ?, repo = ?, source_key = ?, summary = ? WHERE id = ?')
          .run(nextUrl, nextRepo, survivorKey, survivorSummary, survivor.id);
        refreshIdentities(db, survivor.id, row.platform, nextUrl);
      }
    }

    if (hasAffectedCoChange(db)) {
      const repos = db.prepare(`SELECT DISTINCT repo FROM co_change_rules WHERE repo LIKE 'github.com/%/%/%'`)
        .all() as Array<{ repo: string | null }>;
      for (const { repo } of repos) {
        const clean = stripPortFromRepo(repo);
        if (clean) {
          db.prepare('UPDATE co_change_rules SET repo = ? WHERE repo = ?').run(clean, repo);
          touched = true;
        }
      }
    }

    if (touched) bumpRowSetEpoch(db);
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
