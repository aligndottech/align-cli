import { type Command, Option } from 'commander';
import chalk from 'chalk';
import { askWithTimeout } from '../lib/confirm-timeout.js';
import { createConfigStore } from '../lib/config.js';
import { inCi } from '../lib/telemetry-ci.js';
import { BACKFILL_SOURCES } from '../lib/mcp-backfill.js';
import { acquireLock } from '../lib/sync/lock.js';
import { classifyUnclassified, estimateClassify } from '../lib/sync/classify.js';
import { localGraphPath, realStatusDeps, realSyncEnv } from '../lib/sync/real-env.js';
import { renderOutcome } from '../lib/sync/report.js';
import { runSync } from '../lib/sync/run-all.js';
import { recordSourceSynced, type ReportedTrigger, SYNC_TELEMETRY_TOTAL_MS } from '../lib/sync/telemetry.js';
import type { SourceOutcome, SyncEnv } from '../lib/sync/run-source.js';
import { collectStatus, renderStatus, type StatusDeps, TEAMS_NOTE } from '../lib/sync/status.js';
import { BACKGROUND_LAUNCH_DELAY_SECONDS, SYNC_MIN_INTERVAL_MS } from '../lib/sync/should-background-sync.js';
import { refreshSummary } from '../lib/sync/summary.js';
import { nextWindow } from '../lib/sync/window.js';
import { recordRunError } from '../lib/sync/sync-state.js';

/** A background run waits this long before its first request, so it does not compete with the agent's own start-up. */
export const BACKGROUND_DELAY_SECONDS = BACKGROUND_LAUNCH_DELAY_SECONDS;
const DEFAULT_CLASSIFY_MAX = 25;

export interface SyncCommandOptions {
  background?: boolean;
  delay?: string;
  status?: boolean;
  classify?: boolean;
  max?: string;
  yes?: boolean;
  off?: boolean;
  on?: boolean;
}

export interface SyncCommandDeps {
  out(line: string): void;
  err(line: string): void;
  graphPath(): string | undefined;
  env(dbPath: string): SyncEnv;
  statusDeps(dbPath: string): StatusDeps;
  isConnected(id: string): boolean;
  isTty(): boolean;
  /** A default-No question. */
  confirm(message: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  refresh(dbPath: string): void;
  now?(): Date;
  estimate: typeof estimateClassify;
  classify: typeof classifyUnclassified;
  classifyLock(): ReturnType<typeof acquireLock>;
  /** L7: one `source_synced` ping per source outcome. Consent and every other rule live behind it. */
  report?(o: SourceOutcome, trigger: ReportedTrigger): Promise<void>;
  /** A seam for tests; defaults to the real run. */
  run?: typeof runSync;
  /** L6: is the launch-time background refresh switched off (`align sync --off`)? */
  backgroundOff(): boolean;
  setBackgroundOff(off: boolean): void;
  /** Why the launch-time refresh is off in THIS shell regardless of `--off` (ALIGN_NO_SYNC, CI), or undefined. */
  shellGate(): string | undefined;
}

function whole(raw: string | undefined, fallback: number, min: number): number | undefined {
  if (raw === undefined) return fallback;
  return /^\d+$/.test(raw.trim()) && Number(raw) >= min ? Number(raw) : undefined;
}

/** Returns the process exit code. A background run always exits 0: nobody is there to read a failure, and the next run tries again. */
export async function runSyncCommand(sourcesRaw: string[], opts: SyncCommandOptions, d: SyncCommandDeps): Promise<number> {
  let sourcesArg = sourcesRaw;
  if (opts.off || opts.on) {
    // A switch, not a sync: it takes nothing else, so a mistyped `align sync --off github` does not quietly sync (or not).
    if ((opts.off && opts.on) || sourcesArg.length > 0 || opts.status || opts.classify || opts.background || opts.yes || opts.max !== undefined || opts.delay !== undefined) {
      d.err('align sync: --off and --on are used on their own: align sync --off, or align sync --on. They stop or allow only the refresh that runs when you start Align; `align sync`, `align_sync` and `align_backfill` still work.');
      return 2;
    }
    d.setBackgroundOff(opts.off === true);
    d.out(opts.off
      ? 'Background refresh is off. `align sync` still works when you run it. Turn it back on: align sync --on'
      : `Background refresh is on: Align checks your connected sources when you start it, at most every ${SYNC_MIN_INTERVAL_MS / 60_000} minutes per source. Turn it off: align sync --off`);
    return 0;
  }
  let unknown = sourcesArg.filter((s) => !(BACKFILL_SOURCES as readonly string[]).includes(s));
  // A background run has nobody to read an error, and one bad id must not stop the good ones: it skips what it does not know.
  if (opts.background && unknown.length > 0) {
    sourcesArg = sourcesArg.filter((s) => !unknown.includes(s));
    unknown = [];
    if (sourcesArg.length === 0) return 0;
  }
  if (unknown.length > 0) {
    d.err(`align sync: cannot sync ${JSON.stringify(unknown[0]!.slice(0, 16))}. Sources: ${BACKFILL_SOURCES.join(', ')}.`);
    return 2;
  }
  const max = whole(opts.max, DEFAULT_CLASSIFY_MAX, 1);
  if (max === undefined) { d.err('align sync: --max takes a whole number of items, 1 or more.'); return 2; }
  const delay = whole(opts.delay, opts.background ? BACKGROUND_DELAY_SECONDS : 0, 0);
  if (delay === undefined) { d.err('align sync: --delay takes a whole number of seconds.'); return 2; }

  const dbPath = d.graphPath();
  if (dbPath === undefined) {
    d.out('There is no local graph on this machine yet, so there is nothing to sync. Run: align connect');
    return 0;
  }

  if (opts.status) {
    d.out(renderStatus(collectStatus(d.statusDeps(dbPath))));
    const gate = d.shellGate();
    d.out(d.backgroundOff()
      ? 'Background refresh: off. Turn it on: align sync --on'
      : gate !== undefined
        ? `Background refresh: on, but off in this shell (${gate})`
        : `Background refresh: on (at most every ${SYNC_MIN_INTERVAL_MS / 60_000} minutes per source; turn it off: align sync --off)`);
    return 0;
  }
  if (opts.classify) return classifyFlow(dbPath, max, opts, d);

  // Teams tokens last about an hour: it is read only when asked for by name (Decision 21).
  const targets = sourcesArg.length > 0 ? sourcesArg : BACKFILL_SOURCES.filter((s) => d.isConnected(s) && s !== 'teams');
  if (sourcesArg.length === 0 && !opts.background && d.isConnected('teams')) d.out(TEAMS_NOTE);
  if (targets.length === 0 && !opts.background) d.out('No source is connected to sync. Run: align connect <source>');

  if (delay > 0) {
    await d.sleep(delay * 1000);
    // A child the launcher started may have slept through `align sync --off`. (An on-demand run, delay 0, is not the launcher's and ignores the switch.)
    if (opts.background && d.backgroundOff()) return 0;
  }
  const base = d.env(dbPath);
  // L4: a person at the terminal is told, before the first request, what a team scope reads. A background run has nobody to tell.
  const env: SyncEnv = opts.background ? base : { ...base, announce: (_source, line) => d.out(line), confirm: async (_source, message) => d.isTty() && (await askWithTimeout(() => d.confirm(message))) };
  try {
    const trigger = opts.background ? 'background' as const : 'cli' as const;
    let result: Awaited<ReturnType<typeof runSync>>;
    // The pings go out in parallel, each capped at 2 s, and are awaited before the command ends:
    // the background child exits as soon as it returns, and a send nobody awaits would be cut off.
    const pings: Array<Promise<unknown>> = [];
    const reportTrigger: ReportedTrigger = opts.background ? 'background' : 'manual';
    try {
      result = await (d.run ?? runSync)(targets, env, {
        trigger,
        // The launcher's decision is older than the delay: each source re-checks its own age after taking its lock.
        ...(opts.background && delay > 0 ? { minIntervalMs: SYNC_MIN_INTERVAL_MS } : {}),
        onOutcome: (o) => {
          if (!opts.background) for (const line of renderOutcome(o)) d.out(line);
          if (d.report) pings.push(d.report(o, reportTrigger).catch(() => {}));
        },
      });
      await settle(pings);
    } catch (e) {
      await settle(pings);
      // A background child has nobody to tell: record why it stopped where the next foreground moment will see it.
      if (!opts.background) { d.refresh(dbPath); throw e; }
      const now = (d.now ?? (() => new Date()))();
      try { recordRunError(dbPath, targets, e instanceof Error ? e.message : String(e), now.toISOString(), nextWindow(undefined, now).since!); } catch { /* nothing further can be done */ }
      d.refresh(dbPath);
      return 0;
    }
    d.refresh(dbPath);
    if (result.relinkError) {
      if (opts.background) {
        const now = (d.now ?? (() => new Date()))();
        try { recordRunError(dbPath, targets, `finishing links failed: ${result.relinkError}`, now.toISOString(), nextWindow(undefined, now).since!); } catch { /* as above */ }
      } else d.err(`align sync: finishing the links failed: ${result.relinkError}. The sources above were synced; the next sync tries again.`);
    }
    const r = result.relink;
    if (!opts.background && r && r.linked + r.embedded > 0) d.out(`Finished the links for ${r.linked + r.embedded} stored items (on this machine, no AI calls).`);
    if (!opts.background && r?.timedOut) d.out('Stopped finishing links when the time budget ran out; the next sync continues.');
    if (opts.background) return 0;
    return result.outcomes.some((o) => o.state === 'error' || o.state === 'needs_reauth') ? 1 : 0;
  } finally {
    (env.client as unknown as { close?: () => void }).close?.();
  }
}

/** Waits for the pings, started together, for at most SYNC_TELEMETRY_TOTAL_MS in all. */
async function settle(pings: Array<Promise<unknown>>): Promise<void> {
  if (pings.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, SYNC_TELEMETRY_TOTAL_MS); });
  try { await Promise.race([Promise.all(pings), cap]); } finally { clearTimeout(timer); }
}

async function classifyFlow(dbPath: string, max: number, opts: SyncCommandOptions, d: SyncCommandDeps): Promise<number> {
  const est = d.estimate(dbPath, max);
  if (est.available === 0) {
    d.out('Nothing to classify: no imported item has a close match that is still untyped.');
    return 0;
  }
  if (est.provider === undefined) {
    d.err('align sync: no AI provider is configured, so nothing can be classified. Run: align ai');
    return 1;
  }
  d.out(`This classifies ${est.items} of ${est.available} items, using up to ${est.calls} LLM calls on your ${est.provider} key.`);
  if (!opts.yes) {
    if (!d.isTty()) {
      d.err('align sync: --classify spends your AI provider key and asks first, and there is no terminal to ask in. Nothing was sent. Pass --yes to go ahead.');
      return 1;
    }
    if (!(await d.confirm(`Classify ${est.items} items now? This costs money.`))) {
      d.out('Cancelled. Nothing was sent.');
      return 0;
    }
  }
  const lock = d.classifyLock();
  if (!lock.ok) { d.out('Another classification is already running. Try again when it has finished.'); return 0; }
  try {
    const r = await d.classify(dbPath, est.items);
    d.out(`Classified ${r.items} items with ${r.calls} LLM calls: ${r.typed} relationships typed${r.unparsed > 0 ? `, ${r.unparsed} answers could not be read` : ''}.`);
    if (r.stopped) { d.err(`align sync: stopped early: ${r.stopped}. The rest stay untyped; run it again when the provider works.`); return 1; }
    return 0;
  } finally {
    lock.release();
  }
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync [sources...]')
    .description('Bring connected sources up to date in your local graph (reads only, no AI calls)')
    .option('--status', 'Show what is connected, when it last synced and what is waiting')
    .option('--classify', 'Type the relationships of imported items with your own AI key. Asks first')
    .option('--max <n>', `With --classify: how many items at most (default ${DEFAULT_CLASSIFY_MAX})`)
    .option('--yes', 'With --classify: skip the question (needed when there is no terminal)')
    .option('--background', 'Run quietly, as the background refresh does')
    .option('--off', 'Stop the refresh that runs when you start Align (ALIGN_NO_SYNC=1 does the same for one shell)')
    .option('--on', 'Turn the refresh that runs when you start Align back on')
    .addOption(new Option('--delay <seconds>', 'Wait before the first request (background default 20)').hideHelp())
    .action(async (sources: string[], opts: SyncCommandOptions) => {
      const config = createConfigStore();
      const code = await runSyncCommand(sources, opts, {
        out: (l) => console.log(l),
        err: (l) => console.error(chalk.red(l)),
        graphPath: () => localGraphPath(config),
        env: (dbPath) => realSyncEnv(dbPath, config),
        statusDeps: (dbPath) => realStatusDeps(dbPath, config),
        isConnected: (id) => Boolean(config.getConnectorFields('local', id)?.['token']),
        isTty: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
        confirm: async (message) => {
          const p = await import('@clack/prompts');
          const answer = await p.confirm({ message, initialValue: false });
          return answer === true;
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        refresh: (dbPath) => { refreshSummary(dbPath, (id) => Boolean(config.getConnectorFields('local', id)?.['token'])); },
        estimate: estimateClassify,
        classify: classifyUnclassified,
        classifyLock: () => acquireLock('sync-classify'),
        report: recordSourceSynced,
        backgroundOff: () => config.isBackgroundSyncOff(),
        setBackgroundOff: (off) => config.setBackgroundSyncOff(off),
        shellGate: () => (process.env['ALIGN_NO_SYNC'] ? 'ALIGN_NO_SYNC is set' : inCi() ? 'this looks like CI' : undefined),
      });
      if (code !== 0) process.exitCode = code;
    });
}
