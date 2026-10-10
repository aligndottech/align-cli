/**
 * L5: one source, one sync run. The orchestration the pure pieces (window.ts, threads.ts) and
 * the stores (sync-state.ts, drain.ts) are built for. Everything that touches the world arrives
 * through `SyncEnv`, so a test runs the whole flow against a real graph file with a scripted fetch.
 *
 * What a run guarantees:
 * - One writer per source: the lock is taken first and released in `finally`.
 * - The watermark is never ahead of committed data. Items are ingested OLDEST FIRST in batches and,
 *   on a complete read, high_water follows each committed batch; an incomplete read moves nothing
 *   until it is finished (window.ts: finishRun).
 * - A refused token is recorded (`needs_reauth`), never deleted, and never prompted for.
 * - No classification, ever: ingest runs with `classify: false` (Decision 1).
 * - A partial item (a Slack hot-thread re-read) is merged into the stored thread (Review addendum 3).
 */
import type { CaptureFetchResult, CaptureSkip } from '../fetchers/capture.js';
import { isAuthExpiry } from '../errors.js';
import { SYNC_TIME_BUDGET_MS } from '../import-defaults.js';
import type { createLocalGatewayClient } from '../local-gateway-client.js';
import { connectorItemKey } from '../source-key.js';
import { drainGitHub, type DrainResult } from './drain.js';
import type { Lock } from './lock.js';
import type { SourceWindow, SyncScope } from './sources.js';
import {
  advanceHighWater, beginRun, markNeedsReauth, readRows, recordActivity, saveRun, storedByKey, type SyncStatus,
  threadRows,
} from './sync-state.js';
import { HOT_THREAD_DAYS, mergePartialThread, selectHotThreads } from './threads.js';
import { ascendingByUpdated, finishRun, inheritedWindowSince, later, newestUpdated, nextWindow, PERSISTENT_HOLE_RUNS, plausible } from './window.js';

export type SourceState = SyncStatus | 'locked' | 'backfill_running' | 'not_connected' | 'manual';

export interface SourceOutcome {
  source: string;
  state: SourceState;
  /** Items the vendor returned this run. */
  read: number;
  created: number;
  updated: number;
  /** The oldest date this run reached, when it had to say so (an incomplete read). */
  reachedBack?: string;
  /** The lower bound the run asked the vendor for (absent for "all"). */
  since?: string;
  skips: CaptureSkip[];
  drain?: DrainResult;
  scopeNote?: string;
  message?: string;
  /** Set when this run's hole has now come back PERSISTENT_HOLE_RUNS times in a row. */
  persistentHole?: string;
}

export interface SyncEnv {
  dbPath: string;
  now(): Date;
  tokens(source: string): Record<string, string> | null;
  scopeOf(source: string): Promise<SyncScope>;
  fetch(source: string, tokens: Record<string, string>, win: SourceWindow, scope: SyncScope): Promise<CaptureFetchResult>;
  client: Pick<ReturnType<typeof createLocalGatewayClient>, 'ingestBatch' | 'relinkUnfinished'>;
  lock(name: string): Lock;
  backfillRunning(source: string): boolean;
  batchSize?: number;
  /** Re-read ONE item whole by its URL (a Slack thread), or undefined when that is not possible. */
  fetchWhole?: (source: string, tokens: Record<string, string>, url: string) => Promise<CaptureFetchResult['items'][number] | undefined>;
  /** The GitHub discussion drain; defaults to the real one over `client`. A seam for tests. */
  drain?: (token: string, deadlineMs: number) => Promise<DrainResult>;
}

const BATCH = 50;
/**
 * Which incompleteness is a DATE-ORDERED CUT, per source. A cut is only safe to resume with `until = oldestReached` when the fetcher
 * read ONE listing, newest first, and stopped: then everything newer than the oldest item it returned was read. Anything else leaves
 * a gap that no date describes (a space, a team, a channel, a second query, a slice that was never reached), and resuming "below
 * the oldest item" would skip it for good. Read from the SDK (node_modules/@aligndottech/connector-core/dist/fetchers), verified one by one:
 *
 * - jira:   jira.js:52 `ORDER BY updated DESC`, one JQL, one page token chain. Its stops, `time_budget` (:141) and `page_cap` (:146), both say
 *           "older issues not read". With the item limit it emits no skip at all (:182): a cut with no skip kinds.
 * - notion: notion.js:171-197 one search sorted last_edited_time descending. `time_budget` (:238) stops it. Its `page_cap` (:158, :235) is a
 *           page BODY cut, not a listing stop, so it is a hole.
 * - gitlab: gitlab.js:58-112 one merge-request listing, updated_at descending; `time_budget` (:112) stops it. An unreadable page is an
 *           `error` skip and is a hole.
 *
 * Everything else is a hole, by reading, not by guessing:
 * - github: github.js:306-329 runs SEVERAL searches (involves, reviewed-by, issues, or repo PRs and issues), each month-sliced newest first
 *           (githubSearch.js:104-129), then `interleave`s them and trims to the limit (:327). The kept items are a prefix of EACH list, not of
 *           the merged one, so `oldestReached` is the oldest of the shortest prefix and the longer list's items below it are unread.
 *           Its `vendor_cap` (githubSearch.js:146) is a per-slice ceiling with older slices still read.
 * - linear: linear.js:176 two parallel streams (assigned, created); confluence.js:206 one listing per space, `time_budget` ends the loop
 *           with whole spaces unread; teams.js:211-222 team by team, channel by channel; zoom.js:181 30-day windows; slack walks channels.
 */
const CUT_KINDS_BY_SOURCE: Record<string, ReadonlySet<string>> = {
  jira: new Set(['time_budget', 'page_cap']),
  notion: new Set(['time_budget']),
  gitlab: new Set(['time_budget']),
};

/** Platforms whose partial items are threads of messages (Slack hot threads, Teams reply caps). */
const MERGEABLE = new Set(['slack', 'teams']);

const none = (source: string, state: SourceState, message: string): SourceOutcome =>
  ({ source, state, read: 0, created: 0, updated: 0, skips: [], message });

export async function syncSource(
  source: string,
  env: SyncEnv,
  o: { trigger: 'cli' | 'background' } = { trigger: 'cli' },
): Promise<SourceOutcome> {
  const tokens = env.tokens(source);
  if (tokens === null || !tokens['token']) return none(source, 'not_connected', `${source} is not connected. Run: align connect ${source}`);
  // Decision 21: a Teams token lasts about an hour, so a background run would hold a dead one.
  if (source === 'teams' && o.trigger === 'background') return none(source, 'manual', 'Teams is refreshed by hand: align connect teams');

  const lock = env.lock(`sync-${source}`);
  if (!lock.ok) return none(source, 'locked', `already syncing${lock.holder ? ` (started ${lock.holder.started_at.slice(0, 16).replace('T', ' ')} UTC)` : ''}`);
  try {
    if (env.backfillRunning(source)) return none(source, 'backfill_running', `a backfill of ${source} is running; it is reading the same history`);
    return await run(source, tokens, env, lock);
  } finally {
    lock.release();
  }
}

async function run(source: string, tokens: Record<string, string>, env: SyncEnv, lock: Extract<Lock, { ok: true }>): Promise<SourceOutcome> {
  const now = env.now();
  const nowIso = now.toISOString();
  const scope = await env.scopeOf(source);
  const key = { source, scopeKey: scope.scopeKey, scope: scope.scope };
  const rows = readRows(env.dbPath, source);
  // A new scope inherits the depth the person asked for on this source ("all" stays all).
  const row = beginRun(env.dbPath, key, inheritedWindowSince(rows, now), nowIso);
  if (row.status === 'needs_reauth') {
    return none(source, 'needs_reauth', `${source} needs the person to re-authenticate. Run: align connect ${source}`);
  }

  const win = nextWindow(row, now);
  const skips: CaptureSkip[] = [];
  let hotThreads: SourceWindow['hotThreads'];
  if (source === 'slack' && win.since !== undefined) {
    const sel = selectHotThreads(threadRows(env.dbPath, 'slack'), now);
    if (sel.hot.length > 0) hotThreads = sel.hot;
    if (sel.quiet > 0) {
      skips.push({ kind: 'shape', count: sel.quiet, detail: `threads quiet for more than ${HOT_THREAD_DAYS} days are not re-read, so a late reply to one is not picked up` });
    }
  }

  let fetched: CaptureFetchResult;
  try {
    fetched = await env.fetch(source, tokens, { ...win, ...(hotThreads ? { hotThreads } : {}) }, scope);
  } catch (e) {
    return failed(source, key, row.window_since, env, e);
  }
  const { items, report } = fetched;
  // Only a THROWN refusal of the token (above) marks a source needs_reauth. An auth SKIP is one repo, one channel or one
  // project the token cannot see: it stays a skip of this scope and blocks nothing else.
  skips.push(...report.skips);

  const complete = report.complete === true;
  // A cut needs ONE newest-first listing AND nothing but cut-kind skips beside it: any error, auth or other skip means
  // something was unreadable in a place no date describes, and that makes the whole run a hole (see CUT_KINDS_BY_SOURCE).
  const cutKinds = CUT_KINDS_BY_SOURCE[source];
  const cut = !complete && cutKinds !== undefined && report.oldestReached !== undefined
    && report.skips.every((k) => k.kind === 'shape' || (k.kind !== undefined && cutKinds.has(k.kind)));
  const holeSkips = complete || cut ? [] : report.skips.filter((k) => k.kind !== 'shape');
  const holeSig = holeSkips.length === 0 ? null : [...new Set(holeSkips.map((k) => `${k.kind}: ${k.detail.replace(/\d+/g, '#')}`))].sort().join(' | ').slice(0, 400);
  const holeStreak = holeSig === null ? 0 : holeSig === row.hole_sig ? row.hole_streak + 1 : 1;
  const persistent = holeStreak >= PERSISTENT_HOLE_RUNS;
  const lostLock = (): SourceOutcome => none(source, 'locked', 'stopped: another sync took over this source while this one was paused. Nothing more was written.');
  const size = env.batchSize ?? BATCH;
  const wholeReads: WholeReads = { deadline: now.getTime() + WHOLE_THREAD_BUDGET_MS, kept: 0 };
  const ordered = ascendingByUpdated(items);
  let created = 0;
  let updated = 0;
  try {
    for (let at = 0; at < ordered.length; at += size) {
      // A holder that slept past the lock's lifetime may no longer be THE holder: check before every batch.
      if (!lock.owned()) return lostLock();
      const batch = ordered.slice(at, at + size);
      const texts = await prepareBatch(env, tokens, batch, wholeReads);
      const { snapshots } = await env.client.ingestBatch(batch.map((item, i) => ({
        source_url: item.source_url, platform: item.platform, ...texts[i]!,
        ...(item.created_at !== undefined ? { created_at: item.created_at } : {}),
        ...(item.detail_pending === true ? { detail_pending: true } : {}),
      })), { classify: false, keyed: true });
      for (const s of snapshots) { if (s.created) created += 1; else if (s.changed) updated += 1; }
      recordActivity(env.dbPath, key.scopeKey, batch.flatMap((item, i) => (plausible(item.updated_at, now) !== undefined && snapshots[i] ? [{ decisionId: snapshots[i]!.id, platform: item.platform, updatedAt: item.updated_at! }] : [])));
      // Oldest first, so every older item is committed: this stamp is safe to resume from. Only a
      // complete read may move it; an incomplete one is settled by finishRun once the cycle ends.
      const committed = newestUpdated(batch, now);
      if (complete && committed !== undefined) advanceHighWater(env.dbPath, key, committed, now);
      lock.touch();
    }
  } catch (e) {
    return failed(source, key, row.window_since, env, e, { created, updated, read: items.length });
  }

  if (wholeReads.kept > 0) {
    skips.push({ kind: 'shape', count: wholeReads.kept, detail: `thread${wholeReads.kept === 1 ? '' : 's'} kept as partial and merged by appending: the whole thread could not be re-read (${wholeReads.reason ?? 'unknown'})` });
  }
  if (!lock.owned()) return lostLock();
  // The row as it stands now: batches of a complete read have moved high_water already.
  const current = readRows(env.dbPath, source).find((r) => r.scope_key === key.scopeKey) ?? row;
  const fin = finishRun({ high_water: current.high_water, pending_until: row.pending_until }, {
    complete, cut, persistent,
    ...(report.highWater !== undefined ? { highWater: report.highWater } : {}),
    ...(report.oldestReached !== undefined ? { oldestReached: report.oldestReached } : {}),
    // The last run of a cycle a ceiling split: its own highWater is clamped to its `until`, so the
    // cycle's top comes from THIS scope's own row, never from another scope's items.
    ...(row.pending_until !== null && row.cycle_top !== null ? { cycleNewest: row.cycle_top } : {}),
    now,
  });
  const cycleTop = cut ? later(row.cycle_top, plausible(report.highWater, now)) : null;
  const persist = (more: readonly CaptureSkip[]): void => saveRun(env.dbPath, key, {
    ...fin, cycle_top: cycleTop, hole_sig: holeSig, hole_streak: holeStreak, items: items.length, skips: [...skips, ...more],
    attemptAt: env.now().toISOString(),
    // Success is a COMPLETE read. A partial one is an attempt, and must not make the source look freshly synced.
    ...(fin.status === 'ok' ? { successAt: env.now().toISOString() } : {}),
  });
  persist([]);

  let drain: DrainResult | undefined;
  if (source === 'github') {
    const elapsed = env.now().getTime() - now.getTime();
    const deadlineMs = Math.max(30_000, SYNC_TIME_BUDGET_MS - elapsed);
    drain = await (env.drain ? env.drain(tokens['token']!, deadlineMs) : drainGitHub(env.dbPath, env.client, tokens['token']!, { deadlineMs }));
    if (drain.skips.length > 0) persist(drain.skips);
  }
  return {
    source, state: fin.status, read: items.length, created, updated, skips: [...skips, ...(drain?.skips ?? [])],
    ...(win.since !== undefined ? { since: win.since } : {}),
    ...(cut && report.oldestReached !== undefined ? { reachedBack: report.oldestReached } : {}),
    ...(drain ? { drain } : {}),
    ...(persistent && holeSig !== null ? { persistentHole: holeSig } : {}),
    ...(report.scopeNote ? { scopeNote: report.scopeNote } : {}),
  };
}

/**
 * What goes into the graph for one fetched item. A partial item of a thread platform is folded into
 * the stored thread and keeps the stored title (its own was taken from whichever message the re-read
 * began with); anything else goes in as fetched.
 */
interface WholeReads { deadline: number; kept: number; reason?: string }
/** Whole-thread re-reads run three at a time, and all of a run's together get this long, outside the SDK's own budget. */
const WHOLE_THREAD_CONCURRENCY = 3;
const WHOLE_THREAD_BUDGET_MS = 90_000;

async function prepareBatch(
  env: SyncEnv, tokens: Record<string, string>, batch: CaptureFetchResult['items'], whole: WholeReads,
): Promise<Array<{ raw_text: string; title: string | undefined }>> {
  const out: Array<{ raw_text: string; title: string | undefined }> = [];
  for (let at = 0; at < batch.length; at += WHOLE_THREAD_CONCURRENCY) {
    out.push(...await Promise.all(batch.slice(at, at + WHOLE_THREAD_CONCURRENCY).map((item) => prepared(env, tokens, item, whole))));
  }
  return out;
}

async function prepared(env: SyncEnv, tokens: Record<string, string>, item: CaptureFetchResult['items'][number], whole: WholeReads): Promise<{ raw_text: string; title: string | undefined }> {
  if (item.partial !== true || !MERGEABLE.has(item.platform)) return { raw_text: item.raw_text, title: item.title };
  const key = item.source_key ?? connectorItemKey(item.platform, item.source_url);
  const stored = key === undefined ? undefined : storedByKey(env.dbPath, key.startsWith(`${item.platform}|`) ? key : `${item.platform}|${key}`);
  if (stored === undefined) return { raw_text: item.raw_text, title: item.title };
  const merge = (): { raw_text: string; title: string } => ({ raw_text: mergePartialThread(stored.summary, item.raw_text), title: stored.title });
  // The text carries no message times or authors, so an EDITED message cannot be told from a new one by
  // comparing lines. When the thread can be read whole (one or two requests), the whole thread replaces the
  // stored one; only a thread that cannot be read whole is merged by appending, and every such fallback is counted.
  if (env.fetchWhole === undefined) return merge();
  if (env.now().getTime() > whole.deadline) {
    whole.kept += 1;
    whole.reason ??= 'the time allowed for re-reading whole threads ran out';
    return merge();
  }
  try {
    const full = await env.fetchWhole(item.platform, tokens, item.source_url);
    if (full === undefined) return merge(); // this platform has no whole-thread read: nothing was attempted
    if (full.partial !== true) return { raw_text: full.raw_text, title: stored.title };
    whole.kept += 1;
    whole.reason ??= 'the thread is longer than one read returns';
  } catch (e) {
    whole.kept += 1;
    whole.reason ??= (e instanceof Error ? e.message : String(e)).slice(0, 100);
  }
  return merge();
}

function failed(
  source: string, key: { source: string; scopeKey: string; scope: 'yours' | 'team' }, window: string | null, env: SyncEnv, e: unknown,
  partial?: { created: number; updated: number; read: number },
): SourceOutcome {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  const row = readRows(env.dbPath, source).find((r) => r.scope_key === key.scopeKey);
  if (isAuthExpiry(e)) {
    markNeedsReauth(env.dbPath, key, window, env.now().toISOString());
    saveRun(env.dbPath, key, { status: 'needs_reauth', high_water: row?.high_water ?? null, pending_until: row?.pending_until ?? null, cycle_top: row?.cycle_top ?? null, hole_sig: row?.hole_sig ?? null, hole_streak: row?.hole_streak ?? 0, attemptAt: env.now().toISOString(), items: 0, skips: [{ kind: 'auth', count: 1, detail: message }] });
    return { ...none(source, 'needs_reauth', `${source} refused the saved token (${message}). Run: align connect ${source}`), skips: [{ kind: 'auth', count: 1, detail: message }] };
  }
  const skip: CaptureSkip = { kind: 'error', count: 1, detail: message };
  saveRun(env.dbPath, key, { status: 'error', high_water: row?.high_water ?? null, pending_until: row?.pending_until ?? null, cycle_top: row?.cycle_top ?? null, hole_sig: row?.hole_sig ?? null, hole_streak: row?.hole_streak ?? 0, attemptAt: env.now().toISOString(), items: partial?.read ?? 0, skips: [skip] });
  return { source, state: 'error', read: partial?.read ?? 0, created: partial?.created ?? 0, updated: partial?.updated ?? 0, skips: [skip], message };
}
