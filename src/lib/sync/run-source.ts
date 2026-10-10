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
import { ascendingByUpdated, finishRun, later, newestUpdated, nextWindow, plausible } from './window.js';

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
/** Sources whose listing is ONE newest-first stream: a cut in it leaves a date line, everything newer than the oldest item read
 *  is read. Slack walks channel by channel and Zoom is not known to be ordered, so any incompleteness there is a hole. */
const DATE_ORDERED = new Set(['github', 'gitlab', 'jira', 'linear', 'confluence', 'notion', 'teams']);
const CUT_KINDS = new Set(['vendor_cap', 'page_cap', 'time_budget']);
/** Platforms whose partial items are threads of messages that merge by appending (Slack hot threads, Teams reply caps). */
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
  const yours = rows.find((r) => r.scope_key === 'yours');
  // A new scope inherits the depth the person asked for on this source ("all" stays all).
  const row = beginRun(env.dbPath, key, yours ? yours.window_since : nextWindow(undefined, now).since!, nowIso);
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
  const cut = !complete && DATE_ORDERED.has(source) && report.oldestReached !== undefined && report.skips.some((k) => k.kind !== undefined && CUT_KINDS.has(k.kind));
  const lostLock = (): SourceOutcome => none(source, 'locked', 'stopped: another sync took over this source while this one was paused. Nothing more was written.');
  const size = env.batchSize ?? BATCH;
  const ordered = ascendingByUpdated(items);
  let created = 0;
  let updated = 0;
  try {
    for (let at = 0; at < ordered.length; at += size) {
      // A holder that slept past the lock's lifetime may no longer be THE holder: check before every batch.
      if (!lock.owned()) return lostLock();
      const batch = ordered.slice(at, at + size);
      const texts = await Promise.all(batch.map((item) => prepared(env, tokens, item)));
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

  if (!lock.owned()) return lostLock();
  // The row as it stands now: batches of a complete read have moved high_water already.
  const current = readRows(env.dbPath, source).find((r) => r.scope_key === key.scopeKey) ?? row;
  const fin = finishRun({ high_water: current.high_water, pending_until: row.pending_until }, {
    complete, cut,
    ...(report.highWater !== undefined ? { highWater: report.highWater } : {}),
    ...(report.oldestReached !== undefined ? { oldestReached: report.oldestReached } : {}),
    // The last run of a cycle a ceiling split: its own highWater is clamped to its `until`, so the
    // cycle's top comes from THIS scope's own row, never from another scope's items.
    ...(row.pending_until !== null && row.cycle_top !== null ? { cycleNewest: row.cycle_top } : {}),
    now,
  });
  const cycleTop = cut ? later(row.cycle_top, plausible(report.highWater, now)) : null;
  const persist = (more: readonly CaptureSkip[]): void => saveRun(env.dbPath, key, {
    ...fin, cycle_top: cycleTop, items: items.length, skips: [...skips, ...more],
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
    ...(report.scopeNote ? { scopeNote: report.scopeNote } : {}),
  };
}

/**
 * What goes into the graph for one fetched item. A partial item of a thread platform is folded into
 * the stored thread and keeps the stored title (its own was taken from whichever message the re-read
 * began with); anything else goes in as fetched.
 */
async function prepared(env: SyncEnv, tokens: Record<string, string>, item: CaptureFetchResult['items'][number]): Promise<{ raw_text: string; title: string | undefined }> {
  if (item.partial !== true || !MERGEABLE.has(item.platform)) return { raw_text: item.raw_text, title: item.title };
  const key = item.source_key ?? connectorItemKey(item.platform, item.source_url);
  const stored = key === undefined ? undefined : storedByKey(env.dbPath, key.startsWith(`${item.platform}|`) ? key : `${item.platform}|${key}`);
  if (stored === undefined) return { raw_text: item.raw_text, title: item.title };
  // The text carries no message times or authors, so an EDITED message cannot be told from a new one by
  // comparing lines. When the thread can be read whole (one or two requests), the whole thread replaces the
  // stored one; only a thread that cannot be read whole is merged by appending.
  const whole = await env.fetchWhole?.(item.platform, tokens, item.source_url).catch(() => undefined);
  if (whole !== undefined && whole.partial !== true) return { raw_text: whole.raw_text, title: stored.title };
  return { raw_text: mergePartialThread(stored.summary, item.raw_text), title: stored.title };
}

function failed(
  source: string, key: { source: string; scopeKey: string; scope: 'yours' | 'team' }, window: string | null, env: SyncEnv, e: unknown,
  partial?: { created: number; updated: number; read: number },
): SourceOutcome {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  const row = readRows(env.dbPath, source).find((r) => r.scope_key === key.scopeKey);
  if (isAuthExpiry(e)) {
    markNeedsReauth(env.dbPath, key, window, env.now().toISOString());
    saveRun(env.dbPath, key, { status: 'needs_reauth', high_water: row?.high_water ?? null, pending_until: row?.pending_until ?? null, cycle_top: row?.cycle_top ?? null, attemptAt: env.now().toISOString(), items: 0, skips: [{ kind: 'auth', count: 1, detail: message }] });
    return { ...none(source, 'needs_reauth', `${source} refused the saved token (${message}). Run: align connect ${source}`), skips: [{ kind: 'auth', count: 1, detail: message }] };
  }
  const skip: CaptureSkip = { kind: 'error', count: 1, detail: message };
  saveRun(env.dbPath, key, { status: 'error', high_water: row?.high_water ?? null, pending_until: row?.pending_until ?? null, cycle_top: row?.cycle_top ?? null, attemptAt: env.now().toISOString(), items: partial?.read ?? 0, skips: [skip] });
  return { source, state: 'error', read: partial?.read ?? 0, created: partial?.created ?? 0, updated: partial?.updated ?? 0, skips: [skip], message };
}
