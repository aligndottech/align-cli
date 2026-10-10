/**
 * L6: the launch-time background refresh (Decisions 8, 9, 23). Called from launchIfChosen in two
 * halves so the launch cost line stays honest:
 *
 *  - `planBackgroundSync` DECIDES. Read-only: one small JSON file, a lock file per due source, nothing
 *    else. It runs before the overhead trace line, so its time is in the number the budget gates.
 *  - `applyBackgroundPlan` ACTS: prints the two lines, records that it did, and starts the detached
 *    child without waiting for it. It runs only after the dry-run exit, because a dry run measures
 *    and must not change the machine.
 *
 * Imports are deliberately small (no database layer, no fetcher, no setup.ts):
 * launch-path-imports.test.ts walks them. Nothing here throws into the launcher: a failure to
 * decide or to start means no refresh this time, and the agent opens exactly as it would have.
 */
import fs from 'node:fs';
import path from 'node:path';
import { alignStateDirPath, type BackfillStatus, liveBackfills, pidAlive } from '../backfill-state.js';
import { inCi } from '../telemetry-ci.js';
import { lockHolder } from './lock.js';
import { BACKGROUND_LAUNCH_DELAY_SECONDS, REAUTH_LINE_INTERVAL_MS, reauthSources, shouldBackgroundSync, SYNC_MIN_INTERVAL_MS } from './should-background-sync.js';
import { startSyncChild } from './spawn-background.js';
import { readSummary, type SyncSummary } from './summary-read.js';

export const BACKGROUND_SYNC_NOTICE =
  'Align refreshes your connected sources in the background when you start it, at most every 15 minutes per source. Turn off: align sync --off';

export interface BackgroundSyncConfig {
  isBackgroundSyncOff?(): boolean;
  backgroundSyncNoticeShown?(): boolean;
  markBackgroundSyncNoticeShown?(at: string): void;
  getReauthLineShownAt?(): string | undefined;
  markReauthLineShown?(at: string): void;
}

/** The parts that touch the disk or start a process. Tests replace them; the defaults are rooted at the host's env and home. */
export interface BackgroundSyncIo {
  readSummary(): SyncSummary | undefined;
  /** Is a sync or a backfill running for this source right now? */
  busy(source: string): boolean;
  inCi(): boolean;
  /**
   * Take the per-source claim for this interval, atomically (an exclusive create). False when another launch holds a
   * fresh one, or the claim cannot be written: then nothing starts for that source. Concurrent launches inside the child's
   * 20 s delay therefore start ONE child, not one each.
   */
  claim(source: string): boolean;
  releaseClaim(source: string): void;
  /** Fire and forget. The launcher never awaits what this returns. */
  start(sources: string[]): unknown;
  nowMs(): number;
}

export interface BackgroundSyncHost {
  env: Record<string, string | undefined>;
  home: string;
  platform: string;
  isTTY: boolean;
  config: BackgroundSyncConfig;
  err(line: string): void;
  io?: Partial<BackgroundSyncIo>;
}

export interface BackgroundPlan { sources: string[]; reauth: string[] }

const EMPTY: BackgroundPlan = { sources: [], reauth: [] };
const set = (v: string | undefined): boolean => v !== undefined && v !== '';

function readClaimAt(file: string): number | undefined {
  try {
    const at = (JSON.parse(fs.readFileSync(file, 'utf8')) as { at?: unknown }).at;
    return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
}

/** A claim is fresh while it is younger than the interval and not dated in the future. */
const freshClaim = (at: number | undefined, now: number): boolean => at !== undefined && at <= now && now - at < SYNC_MIN_INTERVAL_MS;

function defaultIo(h: BackgroundSyncHost): BackgroundSyncIo {
  const stateDir = alignStateDirPath(h.env, h.home, h.platform);
  const claimFile = (source: string): string => path.join(stateDir, `${source}.bgclaim`);
  // Read once per launch, however many sources are due.
  let backfills: BackfillStatus[] | undefined;
  const runningBackfills = (): BackfillStatus[] => (backfills ??= liveBackfills(path.join(stateDir, 'backfill'), pidAlive));
  return {
    readSummary: () => readSummary(stateDir),
    busy: (source) => lockHolder(`sync-${source}`, { dir: stateDir }) !== undefined
      || runningBackfills().some((s) => s.source === source)
      || freshClaim(readClaimAt(claimFile(source)), Date.now()),
    inCi: () => inCi(h.env),
    claim: (source) => {
      const file = claimFile(source);
      const body = JSON.stringify({ at: Date.now(), pid: process.pid });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
          return true;
        } catch (e) {
          if ((e as { code?: string }).code !== 'EEXIST') return false;
          if (freshClaim(readClaimAt(file), Date.now())) return false;
          try { fs.rmSync(file, { force: true }); } catch { return false; }
        }
      }
      return false;
    },
    releaseClaim: (source) => { try { fs.rmSync(claimFile(source), { force: true }); } catch { /* it expires on its own */ } },
    start: (sources) => startSyncChild(sources, { delaySeconds: BACKGROUND_LAUNCH_DELAY_SECONDS, env: h.env, caller: 'launcher' }),
    nowMs: () => Date.now(),
  };
}

const ioOf = (h: BackgroundSyncHost): BackgroundSyncIo => ({ ...defaultIo(h), ...h.io });

export function planBackgroundSync(h: BackgroundSyncHost): BackgroundPlan {
  try {
    // The cheap gates first: most launches outside a terminal, or with the switch set, read nothing.
    if (!h.isTTY || set(h.env['ALIGN_WRAPPED']) || set(h.env['ALIGN_NO_SYNC'])) return EMPTY;
    if (h.config.isBackgroundSyncOff?.() === true) return EMPTY;
    const io = ioOf(h);
    const summary = io.readSummary();
    if (summary === undefined) return EMPTY;
    const now = io.nowMs();
    const gates = { isTty: h.isTTY, wrapped: false, noSync: false, disabled: false, summary, now };

    // `ci` is asked only when something is due, and `busy` only for what is due.
    let sources = shouldBackgroundSync({ ...gates, ci: false, minIntervalMs: SYNC_MIN_INTERVAL_MS });
    if (sources.length > 0) {
      const busy = new Set(sources.filter((s) => io.busy(s)));
      sources = io.inCi() ? [] : shouldBackgroundSync({ ...gates, ci: false, minIntervalMs: SYNC_MIN_INTERVAL_MS, busy });
    }
    let reauth = reauthSources({ ...gates, ci: false, lastShownAt: h.config.getReauthLineShownAt?.(), intervalMs: REAUTH_LINE_INTERVAL_MS });
    if (reauth.length > 0 && io.inCi()) reauth = [];
    return { sources, reauth };
  } catch {
    return EMPTY;
  }
}

export function applyBackgroundPlan(plan: BackgroundPlan, h: BackgroundSyncHost): void {
  try {
    const io = ioOf(h);
    const stamp = (): string => new Date(io.nowMs()).toISOString();
    // Mark first and print only if the mark held: a config that cannot be written would otherwise repeat the line every launch.
    if (plan.reauth.length > 0) {
      try {
        h.config.markReauthLineShown?.(stamp());
        const s = plan.reauth.length === 1;
        h.err(`Align cannot refresh ${plan.reauth.join(', ')}: ${s ? 'its' : 'their'} saved login stopped working. Reconnect: align connect ${plan.reauth[0]}`);
      } catch { /* an unwritable config: no line this time, and no repeat */ }
    }
    if (plan.sources.length === 0) return;
    if (h.config.backgroundSyncNoticeShown?.() !== true) {
      try {
        h.config.markBackgroundSyncNoticeShown?.(stamp());
      } catch {
        return; // the first-use line cannot be recorded, so it is not shown and nothing starts undisclosed
      }
      h.err(BACKGROUND_SYNC_NOTICE);
    }
    // Only the sources whose claim THIS launch took: a concurrent launch already started those.
    const claimed = plan.sources.filter((s) => io.claim(s));
    if (claimed.length === 0) return;
    // Not awaited: the agent must not wait for a process to be confirmed. A start that fails gives the claim back.
    const release = (): void => { for (const s of claimed) io.releaseClaim(s); };
    try {
      void Promise.resolve(io.start(claimed)).then((r) => { if ((r as { ok?: boolean } | undefined)?.ok === false) release(); }, release);
    } catch {
      release();
    }
  } catch {
    // No refresh this time; the launch goes on.
  }
}
