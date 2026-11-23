/**
 * Make a list of decisions read as a decision list: newest first, one line per decision, a reversal
 * listed once. Pure and deterministic, so the same input renders the same bytes and the freshness check
 * stays valid. Nothing here chooses which decisions exist; it only merges repeats and hides a superseded half.
 */
import { deciderLabel } from './decider-kind.js';
import type { ContextDecision } from './decisions-context.js';

/** A decision as rendered: the row, plus what tidying worked out about it. `orig` is the row it stands for. */
export type TidyRow = ContextDecision & { commits?: number; reverses?: string; orig?: ContextDecision };

const DAY = 86_400_000;
// Anchored to the newest kept row of a title (rows arrive newest first), not chained from the previous row: a gap of
// exactly 365 days collapses, 366 does not, and a third commit 200 days older than the second is 400 from the newest.
const COLLAPSE_WITHIN_DAYS = 365;
const COMMIT_CITE = /@[0-9a-f]{7,40}$/;

/**
 * Epoch ms of a decision's date, or undefined when absent or unparseable. A date-only string and a datetime
 * with no zone are read as UTC: `Date.parse` reads the first as UTC and the second as local time, so two rows
 * tied on one machine would order differently on another.
 */
export function decidedTime(value?: string): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const utc = /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? `${v}T00:00:00Z`
    : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v;
  const t = Date.parse(utc);
  return Number.isNaN(t) ? undefined : t;
}

const time = (d: ContextDecision): number | undefined => decidedTime(d.decidedAt);
// owner/name from a commit, PR, MR or issue URL on a code host.
const REPO_IN_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+?)\/(?:-\/)?(?:commits?|pulls?|issues|merge_requests)\//i;
/** The repository a row belongs to: owner/name from its source URL, so o1/cli and o2/cli stay apart; the cite's name when there is no URL. */
const repoOf = (d: ContextDecision): string => d.sourceUrl?.match(REPO_IN_URL)?.[1]?.toLowerCase() ?? d.cite?.match(/^[^@#]+/)?.[0] ?? '';

/** Newest first, then citation, then title. A missing date sorts after every dated row, never as "now". */
export function newestFirst<T extends ContextDecision>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    if (ta !== tb) return ta === undefined ? 1 : tb === undefined ? -1 : tb - ta;
    return (a.cite ?? '').localeCompare(b.cite ?? '') || a.title.localeCompare(b.title);
  });
}

const isCommit = (d: ContextDecision): boolean => !!d.cite && COMMIT_CITE.test(d.cite);

/** Several commits of one repo with one title, close in time, are one decision. A gap over a year is a second decision. */
function collapseSameTitle(rows: TidyRow[]): TidyRow[] {
  const out: TidyRow[] = [];
  for (const r of rows) {
    const t = time(r);
    const into = isCommit(r) && t !== undefined
      ? out.find((o) => o.title === r.title && isCommit(o) && repoOf(o) === repoOf(r) && time(o) !== undefined && time(o)! - t <= COLLAPSE_WITHIN_DAYS * DAY)
      : undefined;
    if (into) into.commits = (into.commits ?? 1) + 1;
    else out.push(r);
  }
  return out;
}

const norm = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, ' ');
const words = (s: string): string[] => s.split(' ').filter(Boolean);

/** "(#994) throw a instead of b" as [lead-in and A, B], or null when it does not have exactly that one shape. */
function insteadOf(title: string): [string[], string[]] | null {
  const parts = norm(title).replace(/^\(#\d+\)\s*/, '').split(/\s+instead of\s+/);
  return parts.length === 2 && parts[0] && parts[1] ? [words(parts[0]), words(parts[1])] : null;
}

/** "Use A instead of B" and "Use B instead of A": same lead-in, the two things swapped. */
function mirrors(a: string, b: string): boolean {
  const x = insteadOf(a);
  const y = insteadOf(b);
  if (!x || !y) return false;
  let p = 0;
  while (p < x[0].length && p < y[0].length && x[0][p] === y[0][p]) p++;
  const thingX = x[0].slice(p).join(' ');
  const thingY = y[0].slice(p).join(' ');
  return thingX !== '' && thingY !== '' && thingY === x[1].join(' ') && y[1].join(' ') === thingX;
}

/**
 * Only the newer half of an exact mirror pair is listed, tagged with what it reverses. Only inside one repo,
 * only when the pair is the whole family (exactly two rows hold either title: three or more is a decision that
 * went back and forth, and which one stands is not ours to guess), and only when both dates are known and differ.
 */
function dropReversed(rows: TidyRow[], all: TidyRow[]): TidyRow[] {
  const gone = new Set<TidyRow>();
  for (const r of rows) {
    const t = time(r);
    if (gone.has(r) || t === undefined || !r.cite) continue;
    const older = rows.find((o) => o !== r && !gone.has(o) && o.cite && repoOf(o) === repoOf(r)
      && time(o) !== undefined && time(o)! < t && mirrors(r.title, o.title));
    if (!older) continue;
    const family = all.filter((x) => repoOf(x) === repoOf(r) && (norm(x.title) === norm(r.title) || norm(x.title) === norm(older.title)));
    if (family.length !== 2) continue;
    gone.add(older);
    r.reverses = older.cite;
  }
  return rows.filter((r) => !gone.has(r));
}

function isClaim(d: ContextDecision): boolean {
  return deciderLabel({ decider_kind: d.deciderKind, ratified_by: d.ratifiedBy, ratified_at: d.ratifiedAt }) === 'agent-decided, unratified';
}

/**
 * Newest first, repeats merged, reversals hidden. A rule, a claim and a plain decision are tidied apart, so a row
 * is never merged into or reversed by one listed under another heading.
 */
export function tidyDecisions(decisions: ContextDecision[]): TidyRow[] {
  const copies: TidyRow[] = decisions.map((d) => ({ ...d, orig: (d as TidyRow).orig ?? d }));
  const sections = [
    copies.filter((d) => d.kind === 'rule'),
    copies.filter((d) => d.kind !== 'rule' && isClaim(d)),
    copies.filter((d) => d.kind !== 'rule' && !isClaim(d)),
  ];
  const tidied = sections.flatMap((rows) => {
    const sorted = newestFirst(rows);
    return dropReversed(collapseSameTitle(sorted), sorted);
  });
  return newestFirst(tidied);
}
