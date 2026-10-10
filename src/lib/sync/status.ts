/**
 * L5: what is the sync doing, per source, with no item content in it. The same facts back
 * `align sync --status` and `align_sync({ action: 'status' })`.
 *
 * Reads only: the source_sync rows, two counts, the lock files and the backfill status files.
 * It opens a short-lived read handle and never creates anything, so a tool call that asks inside
 * an agent stays inside journey 5's 500 ms.
 */
import { CAPTURE_SOURCES } from '../capture-sources.js';
import type { BackfillStatus } from '../backfill-state.js';
import { BACKFILL_SOURCES } from '../mcp-backfill.js';
import { describeScopeKey, labelOfScopeKey } from '../scope-values.js';
import type { SyncRow, SyncStatus } from './sync-state.js';
import { EMBEDDING_MODEL_ID } from '../local-embeddings.js';
import { PERSISTENT_HOLE_RUNS } from './window.js';
import { pendingDetailCount, readRows, unfinishedCount } from './sync-state.js';

export interface SourceStatus {
  id: string;
  label: string;
  connected: boolean;
  /** Whose items it reads: "your own items", "everyone's items in o/r". */
  scope: string;
  status: SyncStatus | 'never' | 'not_connected';
  /** Stamped only by a COMPLETE run. */
  last_success_at?: string;
  /** Stamped by every run, complete or not. */
  last_attempt_at?: string;
  items_last_run?: number;
  /** GitHub only: items still waiting for their comments and reviews. */
  discussion_pending?: number;
  /** Skip kinds from the last run with how many objects each covered. Never the details, never content. */
  skips: Record<string, number>;
  /** What the last run could not read, in the fetcher's own words, by scope. Never item content or a URL. */
  missing?: string[];
  /** The same hole for PERSISTENT_HOLE_RUNS runs or more: the sync reads the rest and no longer waits for it. */
  persistent_hole?: string;
  /** A read a ceiling cut in date order: how far back it got. Older history is still to come. */
  reached_back_to?: string;
  running?: 'sync' | 'backfill';
  /** The command or note the person needs, when there is one. */
  next_step?: string;
}

export interface StatusDeps {
  dbPath: string;
  isConnected(id: string): boolean;
  /** Is a sync of this source running now (a live, fresh lock)? */
  syncRunning(id: string): boolean;
  /** The latest backfill status file for the source, if any. */
  backfill(id: string): BackfillStatus | null;
  backfillAlive(s: BackfillStatus): boolean;
}

export const TEAMS_NOTE = 'Teams: refresh manually with `align connect teams` (its token lasts about an hour). Only yours until then.';

const label = (id: string): string => (CAPTURE_SOURCES as Record<string, { label: string }>)[id]?.label ?? id;
const RANK: Record<SyncStatus, number> = { ok: 0, partial: 1, error: 2, needs_reauth: 3 };

function scopeText(rows: readonly SyncRow[]): string {
  const team = rows.filter((r) => r.scope === 'team');
  if (team.length === 0) return 'your own items';
  return team.map((r) => describeScopeKey(r.source_id, r.scope_key, r.scope)).join('; ');
}

function scopeLabelOf(r: SyncRow): string {
  return r.scope === 'team' ? labelOfScopeKey(r.source_id, r.scope_key) : 'your own items';
}

/** The skips that mean something was NOT read (everything but `shape`, which is a note), with which scope they hit. */
function missingOf(rows: readonly SyncRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.skips_last_run === null) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(r.skips_last_run); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const s of parsed as Array<{ kind?: unknown; count?: unknown; detail?: unknown }>) {
      if (typeof s.kind !== 'string' || s.kind === 'shape' || typeof s.count !== 'number' || typeof s.detail !== 'string') continue;
      out.push(`${scopeLabelOf(r)}: ${s.count} ${s.detail.slice(0, 160)}`);
    }
  }
  return out.slice(0, 5);
}

function skipCounts(rows: readonly SyncRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.skips_last_run === null) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(r.skips_last_run); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const s of parsed as Array<{ kind?: unknown; count?: unknown }>) {
      if (typeof s.kind === 'string' && typeof s.count === 'number') out[s.kind] = (out[s.kind] ?? 0) + s.count;
    }
  }
  return out;
}

export function collectStatus(d: StatusDeps): { sources: SourceStatus[]; rows_awaiting_relink: number } {
  const all = readRows(d.dbPath);
  const sources: SourceStatus[] = BACKFILL_SOURCES.map((id): SourceStatus => {
    const connected = d.isConnected(id);
    const rows = all.filter((r) => r.source_id === id);
    const worst = rows.reduce<SyncStatus | undefined>((w, r) => (w === undefined || RANK[r.status] > RANK[w] ? r.status : w), undefined);
    const lasts = rows.map((r) => r.last_success_at).filter((t): t is string => t !== null && !Number.isNaN(Date.parse(t)));
    const last = lasts.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    const attempts = rows.map((r) => r.last_attempt_at).filter((t): t is string => t !== null && !Number.isNaN(Date.parse(t)));
    const attempt = attempts.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    const missing = missingOf(rows);
    const stuck = rows.find((r) => r.hole_streak >= PERSISTENT_HOLE_RUNS && r.hole_sig !== null);
    const items = rows.find((r) => r.items_last_run !== null)?.items_last_run ?? undefined;
    const pending = rows.map((r) => r.pending_until).filter((t): t is string => t !== null && !Number.isNaN(Date.parse(t))).sort()[0];
    const bf = d.backfill(id);
    const s: SourceStatus = {
      id, label: label(id), connected, scope: scopeText(rows),
      status: !connected ? 'not_connected' : (worst ?? 'never'),
      skips: skipCounts(rows),
      ...(last !== undefined ? { last_success_at: last } : {}),
      ...(attempt !== undefined ? { last_attempt_at: attempt } : {}),
      ...(missing.length > 0 ? { missing } : {}),
      ...(stuck ? { persistent_hole: `${stuck.hole_sig} (${stuck.hole_streak} runs in a row)` } : {}),
      ...(items !== undefined ? { items_last_run: items } : {}),
      ...(pending !== undefined ? { reached_back_to: pending } : {}),
      ...(connected && d.syncRunning(id) ? { running: 'sync' as const } : bf && d.backfillAlive(bf) ? { running: 'backfill' as const } : {}),
    };
    if (id === 'github' && connected) s.discussion_pending = pendingDetailCount(d.dbPath, 'github');
    if (!connected) s.next_step = `Not connected. Ask the person to run: align connect ${id}`;
    else if (s.status === 'needs_reauth') s.next_step = `The provider refused the saved token. Ask the person to run: align connect ${id}`;
    else if (id === 'teams') s.next_step = TEAMS_NOTE;
    return s;
  });
  return { sources, rows_awaiting_relink: unfinishedCount(d.dbPath, EMBEDDING_MODEL_ID) };
}

/** Plain text for the CLI and for the `text` field of the tool result. Connected sources only. */
export function renderStatus(r: { sources: SourceStatus[]; rows_awaiting_relink: number }): string {
  const lines: string[] = [];
  const connected = r.sources.filter((s) => s.connected);
  if (connected.length === 0) lines.push('No source is connected. Ask the person to run: align connect <source>');
  for (const s of connected) {
    const bits: string[] = [];
    bits.push(s.status === 'never' ? 'not synced yet' : s.status);
    if (s.running) bits.push(s.running === 'sync' ? 'syncing now' : 'a backfill is running');
    const when = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
    if (s.last_success_at) bits.push(`last complete sync ${when(s.last_success_at)}`);
    if (s.last_attempt_at && s.last_attempt_at !== s.last_success_at && s.status !== 'ok') bits.push(`last tried ${when(s.last_attempt_at)}`);
    if (s.items_last_run !== undefined) bits.push(`${s.items_last_run} items read last run`);
    if (s.discussion_pending) bits.push(`${s.discussion_pending} still waiting for their discussion`);
    if (s.reached_back_to) bits.push(`older history still to read (reached ${s.reached_back_to.slice(0, 10)})`);
    if (s.missing) bits.push(`not read last time: ${s.missing.join('; ')}`);
    if (s.persistent_hole) bits.push(`persistent hole: ${s.persistent_hole}; the sync reads the rest and no longer waits for it, so fix the access or leave it`);
    const skips = Object.entries(s.skips).map(([k, n]) => `${k} ${n}`);
    if (skips.length) bits.push(`skipped last run: ${skips.join(', ')}`);
    lines.push(`${s.label} (${s.scope}): ${bits.join('; ')}.`);
    if (s.next_step) lines.push(`  ${s.next_step}`);
  }
  if (r.rows_awaiting_relink > 0) lines.push(`${r.rows_awaiting_relink} stored items wait for their links to be finished. Each sync works on them for up to a minute, locally and free, until they are done.`);
  return lines.join('\n');
}
