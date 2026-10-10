import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type LaunchDeps, launchIfChosen } from '../lib/launch/launch.js';
import { BACKGROUND_SYNC_NOTICE } from '../lib/sync/launch-hook.js';
import type { SummarySource, SyncSummary } from '../lib/sync/summary-read.js';

/**
 * L6 Test List (the launch hook, Decisions 8, 9, 23):
 * - TTY + a connected source last synced 16 min ago -> one detached start with that source; 14 min -> none.
 * - ALIGN_NO_SYNC, no TTY (`align -- ...` piped), CI, `align sync --off` -> none; none of those -> a start.
 * - The first-ever start prints one disclosure line BEFORE the start and before the agent; the second prints none.
 * - A source needing reconnection prints one stderr line before the agent, then not again for 24 hours.
 * - The start is never awaited: a starter that never settles does not hold the agent back; one that throws changes nothing.
 * - A dry run (ALIGN_LAUNCH_DRY_RUN) decides but changes nothing: no start, no line, no config write.
 * - A missing or corrupt sync-summary.json: launch proceeds, nothing starts. A sync or backfill already running for the source: no start.
 */
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
const src = (id: string, over: Partial<SummarySource> = {}): SummarySource => ({ id, backgroundEligible: true, status: 'ok', ...over });
const summary = (...sources: SummarySource[]): SyncSummary => ({ version: 1, generated_at: minutesAgo(1), sources });
const DUE = summary(src('github', { lastSuccessAt: minutesAgo(16) }));

function harness(opts: { summary?: SyncSummary | undefined; env?: Record<string, string>; isTTY?: boolean; argv?: string[]; busy?: (s: string) => boolean; start?: (s: string[]) => unknown; inCi?: boolean; configState?: { off?: boolean; noticeAt?: string; reauthAt?: string }; over?: Partial<LaunchDeps> } = {}) {
  const events: string[] = [];
  const err: string[] = [];
  const state = { off: false, ...opts.configState };
  const configWrites: string[] = [];
  const claims = new Set<string>();
  const start = vi.fn((s: string[]) => { events.push(`start:${s.join(',')}`); return opts.start ? opts.start(s) : undefined; });
  const deps: LaunchDeps = {
    env: { ...opts.env }, argv: opts.argv ?? ['node', 'align'], cwd: '/proj', home: '/home/u', platform: 'linux', isTTY: opts.isTTY ?? true,
    config: {
      getAgent: () => 'claude-code', setAgent: () => {},
      isBackgroundSyncOff: () => state.off === true,
      backgroundSyncNoticeShown: () => state.noticeAt !== undefined,
      markBackgroundSyncNoticeShown: (at: string) => { configWrites.push('notice'); state.noticeAt = at; },
      getReauthLineShownAt: () => state.reauthAt,
      markReauthLineShown: (at: string) => { configWrites.push('reauth'); state.reauthAt = at; },
    } as LaunchDeps['config'],
    findOnPath: (bin) => (bin === 'claude' ? '/usr/bin/claude' : null),
    readProjectState: () => ({ projectHasPreHook: false, projectHasPostHook: false, projectHasMcp: false, projectHasBlock: false }),
    readOpenCodeState: () => ({ projectHasPlugin: false, projectHasMcp: false, projectHasBlock: false }),
    readPiState: () => ({ projectHasExtension: false, projectHasMcp: false, projectHasBlock: false, mcpAdapterInstalled: true, mcpFile: '/x' }),
    readCursorState: () => ({ projectHasMcp: false, mcpFile: '/x' }),
    readCodexState: () => ({ present: false, overridden: [] }),
    readGeminiState: () => ({ present: false, settingsFile: '/x', trust: 'untrusted' }),
    readCopilotState: () => ({ present: false, overridden: [] }),
    pruneLaunchFiles: vi.fn(), applyConfigWrite: vi.fn(), cacheDir: () => '/cache', writeIfChanged: () => true,
    runAgent: vi.fn(async () => { events.push('agent'); return 0; }),
    record: vi.fn(), pick: vi.fn(async () => null), confirm: vi.fn(async () => false), spawnInstall: vi.fn(),
    err: (l) => { err.push(l); events.push(`err:${l.slice(0, 24)}`); },
    now: () => 42,
    backgroundSyncIo: {
      readSummary: () => ('summary' in opts ? opts.summary : DUE),
      busy: opts.busy ?? (() => false),
      inCi: () => opts.inCi ?? false,
      claim: (src: string) => !claims.has(src) && Boolean(claims.add(src)),
      releaseClaim: (src: string) => { claims.delete(src); },
      start,
      nowMs: () => NOW,
    },
    ...opts.over,
  };
  return { deps, events, err, start, state, configWrites };
}

describe('launchIfChosen: background refresh', () => {
  it('starts the due source once, before the agent, and the agent still runs', async () => {
    const h = harness();
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(h.start).toHaveBeenCalledExactlyOnceWith(['github']);
    expect(h.events.indexOf('start:github')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('start:github')).toBeLessThan(h.events.indexOf('agent'));
  });

  it('a source synced 14 minutes ago is left alone, and so is the agent (it still runs)', async () => {
    const h = harness({ summary: summary(src('github', { lastSuccessAt: minutesAgo(14) })) });
    await launchIfChosen(h.deps);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.err).toEqual([]);
    expect(h.events).toEqual(['agent']);
  });

  it.each([
    ['ALIGN_NO_SYNC=1', { env: { ALIGN_NO_SYNC: '1' } }],
    ['no terminal (piped `align -- ...`)', { isTTY: false, argv: ['node', 'align', '--'] }],
    ['CI', { inCi: true }],
    ['align sync --off', { configState: { off: true } }],
    ['no summary file', { summary: undefined }],
  ] as Array<[string, Parameters<typeof harness>[0]]>)('%s -> no start, and the unmodified harness does start', async (_n, o) => {
    const off = harness(o);
    await launchIfChosen(off.deps);
    expect(off.start).not.toHaveBeenCalled();
    expect(off.events).toContain('agent');
    const on = harness();
    await launchIfChosen(on.deps);
    expect(on.start).toHaveBeenCalledTimes(1);
  });

  it('Teams alone starts nothing; Teams with Slack starts Slack only', async () => {
    const teams = src('teams', { backgroundEligible: false, status: 'never' });
    const a = harness({ summary: summary(teams) });
    await launchIfChosen(a.deps);
    expect(a.start).not.toHaveBeenCalled();
    const b = harness({ summary: summary(teams, src('slack', { status: 'ok', lastSuccessAt: minutesAgo(90) })) });
    await launchIfChosen(b.deps);
    expect(b.start).toHaveBeenCalledExactlyOnceWith(['slack']);
  });

  it('a source with a sync or backfill already running is not started again', async () => {
    const h = harness({ busy: (s) => s === 'github' });
    await launchIfChosen(h.deps);
    expect(h.start).not.toHaveBeenCalled();
  });
});

describe('launchIfChosen: the first-use line', () => {
  it('prints the disclosure once, before the start and before the agent; the second launch prints none', async () => {
    const h = harness();
    await launchIfChosen(h.deps);
    expect(h.err).toEqual([BACKGROUND_SYNC_NOTICE]);
    expect(h.events).toEqual([`err:${BACKGROUND_SYNC_NOTICE.slice(0, 24)}`, 'start:github', 'agent']);
    expect(h.configWrites).toEqual(['notice']);
    // second launch, same stored state, source due again
    const again = harness({ configState: { noticeAt: h.state.noticeAt } });
    await launchIfChosen(again.deps);
    expect(again.start).toHaveBeenCalledTimes(1);
    expect(again.err).toEqual([]);
  });

  it('says the interval and how to turn it off', () => {
    expect(BACKGROUND_SYNC_NOTICE).toContain('15 minutes');
    expect(BACKGROUND_SYNC_NOTICE).toContain('align sync --off');
  });

  it('no start means no disclosure (nothing happened that needs disclosing)', async () => {
    const h = harness({ summary: summary(src('github', { lastSuccessAt: minutesAgo(2) })) });
    await launchIfChosen(h.deps);
    expect(h.err).toEqual([]);
    expect(h.configWrites).toEqual([]);
  });
});

describe('launchIfChosen: the reconnect line', () => {
  const stuck = summary(src('github', { status: 'needs_reauth', lastSuccessAt: minutesAgo(500) }));

  it('prints one line naming the source and the command, before the agent', async () => {
    const h = harness({ summary: stuck });
    await launchIfChosen(h.deps);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain('github');
    expect(h.err[0]).toContain('align connect github');
    expect(h.events.at(-1)).toBe('agent');
    expect(h.start).not.toHaveBeenCalled();
    expect(h.configWrites).toEqual(['reauth']);
  });

  it('shown 2 hours ago: not again. shown 25 hours ago: again', async () => {
    const recent = harness({ summary: stuck, configState: { reauthAt: minutesAgo(120) } });
    await launchIfChosen(recent.deps);
    expect(recent.err).toEqual([]);
    const old = harness({ summary: stuck, configState: { reauthAt: minutesAgo(25 * 60) } });
    await launchIfChosen(old.deps);
    expect(old.err).toHaveLength(1);
  });

  it('is silent under ALIGN_NO_SYNC, in CI and after --off, as the refresh is', async () => {
    for (const o of [{ env: { ALIGN_NO_SYNC: '1' } }, { inCi: true }, { configState: { off: true } }]) {
      const h = harness({ summary: stuck, ...o });
      await launchIfChosen(h.deps);
      expect(h.err).toEqual([]);
    }
  });
});

describe('launchIfChosen: the start never holds the agent', () => {
  it('a starter that never settles does not delay the agent', async () => {
    const h = harness({ start: () => new Promise(() => {}) });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(h.deps.runAgent).toHaveBeenCalledTimes(1);
  });

  it('a starter that throws, rejects, or a summary reader that throws changes nothing for the agent', async () => {
    for (const o of [
      { start: () => { throw new Error('spawn EAGAIN'); } },
      { start: () => Promise.reject(new Error('nope')) },
      { over: { backgroundSyncIo: { readSummary: () => { throw new Error('EACCES'); } } } },
    ] as Array<Parameters<typeof harness>[0]>) {
      const h = harness(o);
      expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
      expect(h.deps.runAgent).toHaveBeenCalledTimes(1);
    }
  });
});

describe('launchIfChosen: a dry run changes nothing', () => {
  it('ALIGN_LAUNCH_DRY_RUN decides (it is measured) but starts nothing, prints nothing, writes no config', async () => {
    const reads = vi.fn(() => DUE);
    const h = harness({ env: { ALIGN_LAUNCH_DRY_RUN: '1' }, over: { backgroundSyncIo: { readSummary: reads, busy: () => false, inCi: () => false, claim: () => true, releaseClaim: () => {}, start: vi.fn(), nowMs: () => NOW } } });
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(reads).toHaveBeenCalled();
    expect(h.deps.backgroundSyncIo!.start).not.toHaveBeenCalled();
    expect(h.err).toEqual([]);
    expect(h.configWrites).toEqual([]);
    expect(h.deps.runAgent).not.toHaveBeenCalled();
  });

  it('the trace line comes after the decision, so the budget counts it', async () => {
    const order: string[] = [];
    const h = harness({
      env: { ALIGN_LAUNCH_DRY_RUN: '1', ALIGN_LAUNCH_TRACE: '1' },
      over: { backgroundSyncIo: { readSummary: () => { order.push('read'); return DUE; }, busy: () => false, inCi: () => false, claim: () => true, releaseClaim: () => {}, start: vi.fn(), nowMs: () => NOW } },
    });
    h.deps.err = (l) => order.push(l.startsWith('align-overhead-ms') ? 'trace' : 'other');
    await launchIfChosen(h.deps);
    expect(order).toEqual(['read', 'trace']);
  });
});

describe('the default reader (rooted at the launcher\'s own env and home)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l6-hook-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function real(files: Record<string, string>) {
    const state = path.join(dir, 'align-cli');
    fs.mkdirSync(path.join(state, 'backfill'), { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(state, name), body);
    const start = vi.fn();
    const h = harness({ env: { XDG_STATE_HOME: dir }, over: { backgroundSyncIo: { start, nowMs: () => NOW, inCi: () => false } } });
    return { h, start };
  }
  const summaryFile = (s: SyncSummary): string => JSON.stringify(s);

  it('reads sync-summary.json from XDG_STATE_HOME and starts the due source', async () => {
    const { h, start } = real({ 'sync-summary.json': summaryFile(DUE) });
    await launchIfChosen(h.deps);
    expect(start).toHaveBeenCalledExactlyOnceWith(['github']);
  });

  it('a corrupt file, a foreign file and a missing file start nothing and do not stop the agent', async () => {
    for (const files of [{ 'sync-summary.json': '{not json' }, { 'sync-summary.json': '{"version":2,"sources":[]}' }, {}]) {
      const { h, start } = real(files);
      expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
      expect(start).not.toHaveBeenCalled();
    }
  });

  it('a live sync lock for the source holds the start back; a dead holder does not', async () => {
    const lock = (pid: number) => JSON.stringify({ pid, started_at: new Date(NOW).toISOString(), at: Date.now(), nonce: 'n' });
    const live = real({ 'sync-summary.json': summaryFile(DUE), 'sync-github.lock': lock(process.pid) });
    await launchIfChosen(live.h.deps);
    expect(live.start).not.toHaveBeenCalled();
    const dead = real({ 'sync-summary.json': summaryFile(DUE), 'sync-github.lock': lock(2 ** 22 + 12345) });
    await launchIfChosen(dead.h.deps);
    expect(dead.start).toHaveBeenCalledTimes(1);
  });

  it('a running backfill for the source holds the start back', async () => {
    const state = path.join(dir, 'align-cli');
    const { h, start } = real({ 'sync-summary.json': summaryFile(DUE) });
    fs.writeFileSync(path.join(state, 'backfill', 'github.json'), JSON.stringify({ source: 'github', pid: process.pid, started_at: new Date().toISOString(), state: 'running' }));
    await launchIfChosen(h.deps);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('concurrent launches and the claim (the 15-minute rule across launches)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l6-claim-')); fs.mkdirSync(path.join(dir, 'align-cli', 'backfill'), { recursive: true }); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = (): string => path.join(dir, 'align-cli');
  const write = (s: SyncSummary): void => fs.writeFileSync(path.join(state(), 'sync-summary.json'), JSON.stringify(s));
  const launch = (start: (s: string[]) => unknown, extra: Record<string, unknown> = {}) => {
    const h = harness({ env: { XDG_STATE_HOME: dir }, over: { backgroundSyncIo: { start, nowMs: () => NOW, inCi: () => false, ...extra } } });
    return launchIfChosen(h.deps);
  };
  // The real claim reads the wall clock; the summary's stamps are relative to it.
  const dueNow = (): SyncSummary => summary(src('github', { lastSuccessAt: new Date(Date.now() - 60 * 60_000).toISOString() }));

  it('five rapid launches start ONE child for the source', async () => {
    write(dueNow());
    const start = vi.fn();
    for (let i = 0; i < 5; i++) await launch(start, { nowMs: () => Date.now() });
    expect(start).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(state()).filter((n) => /^github\.\d+\.bgclaim$/.test(n))).toHaveLength(1);
  });

  it('two claims race for the same source at once: exactly one wins', async () => {
    write(dueNow());
    const start = vi.fn();
    await Promise.all(Array.from({ length: 6 }, () => launch(start, { nowMs: () => Date.now() })));
    expect(start).toHaveBeenCalledTimes(1);
  });

  const bucketNow = (): number => Math.floor(Date.now() / (15 * 60_000));
  it('a claim older than the interval is stale and a new launch starts; a fresh one holds', async () => {
    write(dueNow());
    // dated 16 minutes ago, in the previous bucket or the one before: not in force
    fs.writeFileSync(path.join(state(), `github.${bucketNow() - 1}.bgclaim`), JSON.stringify({ at: Date.now() - 16 * 60_000 }));
    const stale = vi.fn();
    await launch(stale, { nowMs: () => Date.now() });
    expect(stale).toHaveBeenCalledTimes(1);
    fs.rmSync(path.join(state(), `github.${bucketNow()}.bgclaim`), { force: true });
    fs.writeFileSync(path.join(state(), `github.${bucketNow() - 1}.bgclaim`), JSON.stringify({ at: Date.now() - 1000 }));
    const fresh = vi.fn();
    await launch(fresh, { nowMs: () => Date.now() });
    expect(fresh).not.toHaveBeenCalled();
  });

  it('a start that fails gives the claim back, so the next launch may try again', async () => {
    write(dueNow());
    await launch(vi.fn(async () => ({ ok: false })), { nowMs: () => Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(path.join(state(), 'github.bgclaim'))).toBe(false);
    const ok = vi.fn();
    await launch(ok, { nowMs: () => Date.now() });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('an unwritable state directory means no start (and the agent still runs)', async () => {
    write(dueNow());
    fs.chmodSync(state(), 0o500);
    try {
      if (process.platform === 'win32' || process.getuid?.() === 0) return;
      const start = vi.fn();
      expect(await launch(start, { nowMs: () => Date.now() })).toEqual({ handled: true, code: 0 });
      expect(start).not.toHaveBeenCalled();
    } finally { fs.chmodSync(state(), 0o700); }
  });

  it('the launcher starts the child as the launcher, from the real starter\'s options (caller)', async () => {
    write(dueNow());
    const h = harness({ env: { XDG_STATE_HOME: dir } });
    const seen: unknown[] = [];
    vi.doMock('../lib/sync/spawn-background.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), startSyncChild: (...a: unknown[]) => { seen.push(a); return Promise.resolve({ ok: true }); } }));
    vi.resetModules();
    const { launchIfChosen: fresh } = await import('../lib/launch/launch.js');
    await fresh({ ...h.deps, backgroundSyncIo: { nowMs: () => Date.now(), inCi: () => false } });
    vi.doUnmock('../lib/sync/spawn-background.js');
    expect(seen).toHaveLength(1);
    expect((seen[0] as [string[], { caller: string }])[1].caller).toBe('launcher');
  });
});

describe('a summary that is hostile or huge', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l6-big-')); fs.mkdirSync(path.join(dir, 'align-cli', 'backfill'), { recursive: true }); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = async (sources: SummarySource[], start = vi.fn()) => {
    fs.writeFileSync(path.join(dir, 'align-cli', 'sync-summary.json'), JSON.stringify(summary(...sources)));
    const h = harness({ env: { XDG_STATE_HOME: dir }, over: { backgroundSyncIo: { start, nowMs: () => Date.now(), inCi: () => false } } });
    const t0 = performance.now();
    await launchIfChosen(h.deps);
    return { ms: performance.now() - t0, start };
  };
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const clear = (): void => { for (const n of fs.readdirSync(path.join(dir, 'align-cli'))) if (n.endsWith('.bgclaim')) fs.rmSync(path.join(dir, 'align-cli', n)); };

  it('one id that is not a source does not block the real ones', async () => {
    const { start } = await run([src('myspace', { status: 'ok', lastSuccessAt: minutesAgo(90) }), src('github', { lastSuccessAt: old })]);
    expect(start).toHaveBeenCalledExactlyOnceWith(['github']);
  });

  it('20,000 junk ids cost the launch no more than 20 ms over a one-source summary, and start only the real source', async () => {
    const junk = Array.from({ length: 20_000 }, (_, i) => src(`junk${i}`, { status: 'ok', lastSuccessAt: minutesAgo(90) }));
    await run([src('github', { lastSuccessAt: old })]); // warm the code
    clear();
    const small = await run([src('github', { lastSuccessAt: old })]);
    clear();
    const big = await run([...junk, src('github', { lastSuccessAt: old })]);
    expect(big.start).toHaveBeenCalledExactlyOnceWith(['github']);
    expect(big.ms - small.ms).toBeLessThan(20);
  });
});

describe('an unwritable config', () => {
  it('the first-use line is marked before it is printed: a mark that fails prints nothing and starts nothing, and a later launch does not repeat a line', async () => {
    const h = harness();
    (h.deps.config as { markBackgroundSyncNoticeShown: () => void }).markBackgroundSyncNoticeShown = () => { throw new Error('EACCES: config.json'); };
    expect(await launchIfChosen(h.deps)).toEqual({ handled: true, code: 0 });
    expect(h.err).toEqual([]);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.deps.runAgent).toHaveBeenCalledTimes(1);
  });
  it('the reconnect line is marked first too: an unwritable config prints no line', async () => {
    const h = harness({ summary: summary(src('github', { status: 'needs_reauth' })) });
    (h.deps.config as { markReauthLineShown: () => void }).markReauthLineShown = () => { throw new Error('EACCES'); };
    await launchIfChosen(h.deps);
    expect(h.err).toEqual([]);
  });
  it('the mark is written before the line is printed (order)', async () => {
    const h = harness();
    await launchIfChosen(h.deps);
    expect(h.configWrites).toEqual(['notice']);
    expect(h.events.indexOf(`err:${BACKGROUND_SYNC_NOTICE.slice(0, 24)}`)).toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(process.platform === 'win32')('a FIFO where a file is expected never hangs the launch', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l6-fifo-')); fs.mkdirSync(path.join(dir, 'align-cli', 'backfill'), { recursive: true }); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = (): string => path.join(dir, 'align-cli');
  const hostFor = () => ({ env: { XDG_STATE_HOME: dir }, home: '/home/u', platform: 'linux', isTTY: true, config: {}, err: () => {} });
  const old = (): string => new Date(Date.now() - 3_600_000).toISOString();

  it('a FIFO at sync-summary.json: the plan is empty, within 50 ms', async () => {
    const { planBackgroundSync } = await import('../lib/sync/launch-hook.js');
    execFileSync('mkfifo', [path.join(state(), 'sync-summary.json')]);
    const t0 = performance.now();
    expect(planBackgroundSync(hostFor())).toEqual({ sources: [], reauth: [] });
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('a FIFO at a claim path, a sync lock and a backfill status: the source is skipped or still starts, within 50 ms, and nothing blocks', async () => {
    const { planBackgroundSync, applyBackgroundPlan } = await import('../lib/sync/launch-hook.js');
    fs.writeFileSync(path.join(state(), 'sync-summary.json'), JSON.stringify(summary(src('github', { lastSuccessAt: old() }), src('jira', { lastSuccessAt: old() }), src('slack', { lastSuccessAt: old() }))));
    execFileSync('mkfifo', [path.join(state(), `github.${Math.floor(Date.now() / (15 * 60_000))}.bgclaim`)]);
    execFileSync('mkfifo', [path.join(state(), 'sync-jira.lock')]);
    execFileSync('mkfifo', [path.join(state(), 'backfill', 'slack.json')]);
    const t0 = performance.now();
    const plan = planBackgroundSync(hostFor());
    const started: string[][] = [];
    applyBackgroundPlan(plan, { ...hostFor(), config: { backgroundSyncNoticeShown: () => true }, io: { start: (s: string[]) => { started.push(s); } } });
    expect(performance.now() - t0).toBeLessThan(50);
    // the FIFO claim cannot be taken (an object in the way): github is skipped; the others are not blocked
    expect(started.flat().sort()).toEqual(['jira', 'slack']);
  });
});

describe('a summary written by the sync job: sources a person must act on', () => {
  it('a blocked marker becomes the source\'s status in the file the launcher reads, and clearing it brings the status back', async () => {
    const { refreshSummary } = await import('../lib/sync/summary.js');
    const { readSummary } = await import('../lib/sync/summary-read.js');
    const { createLocalDb } = await import('../lib/local-db.js');
    const { writeBlocked, clearBlocked } = await import('../lib/sync/blocked.js');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l6-blk-'));
    try {
      const db = path.join(d, 'g.db'); createLocalDb(db).close();
      const connected = (id: string): boolean => ['confluence', 'github'].includes(id);
      writeBlocked('confluence', 'manual', 'Pick spaces: align connect confluence', d);
      expect(refreshSummary(db, connected, new Date(), d)).toBe(true);
      expect(Object.fromEntries(readSummary(d)!.sources.map((x) => [x.id, x.status]))).toEqual({ github: 'never', confluence: 'manual' });
      clearBlocked('confluence', d);
      refreshSummary(db, connected, new Date(), d);
      expect(readSummary(d)!.sources.find((x) => x.id === 'confluence')?.status).toBe('never');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }, 30_000);
});
