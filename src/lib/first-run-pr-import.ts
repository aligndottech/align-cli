/**
 * First run reads the merged PR descriptions of a GitHub origin.
 *
 * Why: most commits never state a reason (measured null "no stated reason" rate: fastify 96.7%,
 * vite 96.7%, pnpm 74.0%), because squash-merge repos keep the reason in the PR description, not
 * in the commit. `extractReason` over those descriptions found one in 15-29% of merged PRs.
 *
 * Safe by construction, because it runs before anyone has been asked anything:
 *  - public data only. No token is needed; a token is used ONLY when the existing read-only gate
 *    (detectVerifiedCliToken) proves it cannot write, and anything it refuses is dropped, never
 *    sent. A refusal costs nothing: the unauthenticated read still runs.
 *  - bounded: 3 pages (300 PRs) without a token, 10 pages (1,000) with one, and one wall-clock
 *    deadline over the whole thing, token lookup included.
 *  - never a prompt and never an error: every failure resolves to "no PRs".
 *  - a rate limit (HTTP 403/429) degrades to commits only, with one honest line.
 *
 * What it imports is a decision per merged PR whose body states a reason (the same gate the git
 * import applies to commits), at the PR's own url, so `align connect github` writes the same row
 * and a re-run does not duplicate it. A squash commit whose PR was imported is dropped from the
 * commit import (dropCoveredCommits) so the change is not listed twice.
 */
import type { PersonalImportItem } from './personal-import.js';
import { extractReason } from './reason-extract.js';
import { CLI_TOKEN_SOURCES, detectVerifiedCliToken } from './setup-ux.js';

export const RATE_LIMIT_LINE = 'GitHub rate limit reached, imported commits only; run `align connect github` for PR descriptions';
export const partialRateLimitLine = (imported: number): string =>
  `GitHub rate limit reached after ${imported} PR descriptions; run \`align connect github\` for the rest`;

const PAGE_SIZE = 100;
const UNAUTH_LIMITS = { prs: 300, pages: 3 } as const;
const TOKEN_LIMITS = { prs: 1_000, pages: 10 } as const;
/** Wall clock for everything here. First run must not wait on GitHub longer than this. */
export const PR_DEADLINE_MS = 10_000;
/** A PR body is read for a reason only in its first few thousand characters (extractReason's own bound). */
const BODY_CAP = 8_000;

const API = 'https://api.github.com';
const GITHUB_PREFIX = 'github.com/';
const OWNER_REPO = /^(?!\.{1,2}\/)(?!.*\/\.{1,2}$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface ApiPr {
  number?: number; title?: string; body?: string | null; html_url?: string; merged_at?: string | null;
  updated_at?: string | null; merge_commit_sha?: string | null;
  user?: { login?: string; type?: string; html_url?: string } | null;
  base?: { repo?: { full_name?: string } | null } | null;
}

export interface FirstRunPrOutcome {
  items: PersonalImportItem[];
  /** Merged, non-bot PRs read. */
  scanned: number;
  /** PRs kept: the ones whose body states a reason. */
  imported: number;
  /** The one line to show when GitHub stopped the read; absent otherwise. */
  note?: string;
  numbers: ReadonlySet<number>;
  shas: ReadonlySet<string>;
}

const EMPTY: FirstRunPrOutcome = { items: [], scanned: 0, imported: 0, numbers: new Set(), shas: new Set() };

export interface FirstRunPrDeps {
  fetchFn?: typeof fetch;
  /** The token source. Default: the existing `gh` gate, which returns a token only once proven read-only. */
  detectToken?: () => Promise<{ token: string } | { refused: string } | null>;
  deadlineMs?: number;
}

const isBot = (u: ApiPr['user']): boolean => u?.type === 'Bot' || /\[bot\]$/i.test(u?.login ?? '') || /^(?:dependabot|renovate)\b/i.test(u?.login ?? '');

function toItem(p: ApiPr, repo: string): PersonalImportItem {
  const full = p.base?.repo?.full_name ?? repo;
  const merged = new Date(p.merged_at as string).toISOString();
  const updated = p.updated_at ? new Date(p.updated_at) : undefined;
  return {
    source_url: p.html_url as string,
    platform: 'github',
    // The same text connector-core's GitHubFetcher builds (baseText), so a later `align connect github` agrees with it.
    raw_text: `${p.title}\n\n${(p.body ?? '').slice(0, BODY_CAP)}\n\nStatus: merged\nRepo: ${full}`.trim(),
    title: p.title as string,
    // decided_at is the merge, not the opening.
    created_at: merged,
    ...(updated && !Number.isNaN(updated.getTime()) ? { updated_at: updated.toISOString() } : {}),
    ...(p.user?.login ? { author: { name: p.user.login, handle: p.user.login, ...(p.user.html_url ? { url: p.user.html_url } : {}) } } : {}),
  } as PersonalImportItem;
}

async function read(repo: string, token: string | undefined, fetchFn: typeof fetch, signal: AbortSignal): Promise<FirstRunPrOutcome> {
  const limits = token ? TOKEN_LIMITS : UNAUTH_LIMITS;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'align-cli' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const items: PersonalImportItem[] = [];
  const numbers = new Set<number>();
  const shas = new Set<string>();
  let scanned = 0;
  let limited = false;
  for (let page = 1; page <= limits.pages && scanned < limits.prs; page += 1) {
    let res: Response;
    try {
      res = await fetchFn(`${API}/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`, { headers, signal });
    } catch {
      break; // network, timeout or abort: keep what was read
    }
    // 429 is a limit. A 403 is one only when GitHub says no quota is left (or tells us when to retry); any other
    // 403 (a blocked repo, an SSO wall) is not a rate limit and gets no rate-limit line.
    if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))) { limited = true; break; }
    if (!res.ok) break; // 404 (private repo, no token), 5xx: say nothing
    let rows: ApiPr[];
    try {
      const body: unknown = await res.json();
      if (!Array.isArray(body)) break;
      rows = body as ApiPr[];
    } catch {
      break;
    }
    for (const p of rows) {
      if (scanned >= limits.prs) break;
      if (!p.merged_at || !p.html_url || !p.title || typeof p.number !== 'number' || isBot(p.user) || Number.isNaN(new Date(p.merged_at).getTime())) continue;
      scanned += 1;
      if (!extractReason(p.title, p.body)) continue;
      items.push(toItem(p, repo));
      numbers.add(p.number);
      if (p.merge_commit_sha) shas.add(p.merge_commit_sha.toLowerCase());
    }
    // Nothing left to read, or no quota left to read it with: stop quietly rather than draw a 403.
    if (rows.length < PAGE_SIZE || res.headers.get('x-ratelimit-remaining') === '0') break;
  }
  const note = limited ? (items.length === 0 ? RATE_LIMIT_LINE : partialRateLimitLine(items.length)) : undefined;
  return { items, scanned, imported: items.length, ...(note ? { note } : {}), numbers, shas };
}

/** Never rejects. Resolves to no PRs for any origin that is not a github.com repo. */
export async function fetchFirstRunPrs(repoIdentity: string | null | undefined, deps: FirstRunPrDeps = {}): Promise<FirstRunPrOutcome> {
  if (!repoIdentity?.startsWith(GITHUB_PREFIX)) return EMPTY;
  const repo = repoIdentity.slice(GITHUB_PREFIX.length);
  if (!OWNER_REPO.test(repo)) return EMPTY;
  const fetchFn = deps.fetchFn ?? fetch;
  const detect = deps.detectToken ?? (() => detectVerifiedCliToken(CLI_TOKEN_SOURCES['github']!));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<FirstRunPrOutcome>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(EMPTY); }, deps.deadlineMs ?? PR_DEADLINE_MS);
    timer.unref?.();
  });
  const work = (async (): Promise<FirstRunPrOutcome> => {
    let token: string | undefined;
    try {
      const found = await detect();
      // Only a token the gate returned as proven read-only; a refusal is not a token.
      if (found && 'token' in found && found.token) token = found.token;
    } catch { /* no token: the public read still works */ }
    return read(repo, token, fetchFn, controller.signal);
  })().catch(() => EMPTY);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const SQUASH_PR_NUMBER = /\(#(\d+)\)\s*$/;
const COMMIT_SHA = /\/commit\/([0-9a-f]{40})(?:[/?#]|$)/;

/**
 * The commits that are NOT the squash of an imported PR. A commit is covered when its sha IS that PR's
 * merge commit (GitHub's own statement of which commit the PR became). A `(#N)` in a subject is not
 * enough on its own here: a fork's history carries upstream commits titled with upstream's PR numbers.
 * A PR that was not imported covers nothing: its commit is then the only row for the change.
 */
export function dropCoveredCommits<T extends { title?: string; source_url?: string }>(
  commits: T[],
  outcome: Pick<FirstRunPrOutcome, 'shas'>,
): { items: T[]; covered: number } {
  if (outcome.shas.size === 0) return { items: commits, covered: 0 };
  const items = commits.filter((c) => {
    const sha = COMMIT_SHA.exec(c.source_url ?? '')?.[1];
    return !(sha !== undefined && outcome.shas.has(sha.toLowerCase()));
  });
  return { items, covered: commits.length - items.length };
}

/**
 * Later, `align connect git` re-reads commits with no PR read of its own. The PR rows first run stored are in
 * the graph, so a commit whose subject ends in `(#N)` for a stored PR url of the SAME repo is the one the PR
 * replaced, and is not written again.
 */
export function dropCommitsOfStoredPrs<T extends { subject: string }>(
  commits: T[],
  storedPrUrls: Iterable<string>,
  repo: string,
): { items: T[]; covered: number } {
  const prefix = `https://github.com/${repo.toLowerCase()}/pull/`;
  const numbers = new Set<string>();
  for (const u of storedPrUrls) if (u.toLowerCase().startsWith(prefix)) numbers.add(u.slice(prefix.length).replace(/[/?#].*$/, ''));
  if (numbers.size === 0) return { items: commits, covered: 0 };
  const items = commits.filter((c) => {
    const n = SQUASH_PR_NUMBER.exec(c.subject)?.[1];
    return !(n !== undefined && numbers.has(n));
  });
  return { items, covered: commits.length - items.length };
}
