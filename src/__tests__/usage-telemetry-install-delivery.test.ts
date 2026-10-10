/**
 * The install beacon is the funnel's denominator, and it is once-only: the stage is marked before
 * the send. A fire-and-forget send therefore lost the install forever whenever the command
 * exited before the request started (`align status` on a set-up local install does). So the
 * FIRST-RUN beacon is awaited before the command runs, with a hard cap. If the connection fails,
 * the stage is released and the next run retries; if the request was written but not answered
 * in time, it may have arrived, so that counts as the one attempt and the stage stays claimed. Every other run, and every other event, stays
 * fire-and-forget.
 *
 * The listener is a fetch double with a controllable delay that honours the abort signal, the way
 * a real socket does. The config store is a stateful fake, so claim and release are visible to the
 * next call without touching ~/.config/align-cli.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
import type { EnvironmentConfig } from '../lib/config.js';

const state = vi.hoisted(() => ({ stages: [] as string[], noticeShownAt: '2026-10-10T00:00:00.000Z' as string | undefined }));

vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getTelemetryConsent: () => undefined,
    getTelemetryNoticeShownAt: () => state.noticeShownAt,
    markTelemetryNoticeShown: () => {},
    getInstallId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    wasFunnelStageRecorded: (s: string) => state.stages.includes(s),
    markFunnelStageRecorded: (s: string) => { if (!state.stages.includes(s)) state.stages.push(s); },
    claimFunnelStage: (s: string) => {
      if (state.stages.includes(s)) return false;
      state.stages.push(s);
      return true;
    },
    releaseFunnelStage: (s: string) => {
      const had = state.stages.includes(s);
      state.stages = state.stages.filter((x) => x !== s);
      return had;
    },
    getEnvironment: (): EnvironmentConfig => ({ gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' }),
  }),
  ALIGN_HOSTED_GATEWAY_URL: 'https://api.align.tech',
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));

import { beginInvocationTelemetry, INSTALL_BEACON_CAP_MS } from '../lib/usage-telemetry.js';

type Listener = 'answers' | 'never-answers' | 'refuses';
let listener: Listener = 'answers';
const events: string[] = [];

/** A listener double: answers 201, never answers until aborted, or refuses the connection. */
const fetchDouble = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
  events.push('request-written');
  if (listener === 'refuses') return Promise.reject(new TypeError('fetch failed: ECONNREFUSED'));
  if (listener === 'answers') {
    return new Promise<Response>((resolve) => setTimeout(() => { events.push('answered'); resolve(new Response(null, { status: 201 })); }, 20));
  }
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
  });
});
vi.stubGlobal('fetch', fetchDouble);

let stderrSpy: ReturnType<typeof vi.spyOn>;

/** What cli.ts's preAction awaits, then the command - here, one that exits at once. */
async function quickExitRun(): Promise<void> {
  await beginInvocationTelemetry('status', { hook: false });
  events.push('command-exited');
}

describe('the first-run install beacon is delivered before the command runs', () => {
  beforeEach(() => {
    clearTelemetryEnv();
    state.stages = [];
    state.noticeShownAt = '2026-10-10T00:00:00.000Z';
    listener = 'answers';
    events.length = 0;
    fetchDouble.mockClear();
    // The notice is already shown in these tests; anything else on stderr would be a leak.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    stderrSpy.mockRestore();
  });

  it('the cap is under a second', () => {
    expect(INSTALL_BEACON_CAP_MS).toBeGreaterThan(0);
    expect(INSTALL_BEACON_CAP_MS).toBeLessThanOrEqual(1000);
  });

  it('quick-exit first run: the request reaches the listener and is answered before the command exits', async () => {
    await quickExitRun();
    expect(events).toEqual(['request-written', 'answered', 'command-exited']);
    expect(state.stages).toContain('install');
  });

  // A request that was written but never answered may well have arrived, so it is ONE attempt:
  // the stage stays claimed. Releasing it here made every run behind a silent gateway pay the cap
  // again and send again (re-review of 03cdbf0).
  it('a listener that never answers: the run is held at most ~1s, nothing prints or throws, and the stage stays claimed', async () => {
    listener = 'never-answers';
    const started = Date.now();
    await expect(quickExitRun()).resolves.toBeUndefined();
    const held = Date.now() - started;
    expect(held).toBeLessThan(1100);
    expect(held).toBeGreaterThanOrEqual(INSTALL_BEACON_CAP_MS - 50);
    expect(events).toEqual(['request-written', 'command-exited']);
    expect(state.stages).toContain('install');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('behind a silent gateway, three runs make one request, and runs 2 and 3 are not held', async () => {
    listener = 'never-answers';
    await quickExitRun();
    const held: number[] = [];
    for (let i = 0; i < 2; i++) {
      const started = Date.now();
      await quickExitRun();
      held.push(Date.now() - started);
    }
    expect(fetchDouble).toHaveBeenCalledTimes(1);
    for (const ms of held) expect(ms).toBeLessThan(100);
  });

  it('a refused connection (nothing was written to a gateway) releases the stage, at once', async () => {
    listener = 'refuses';
    const started = Date.now();
    await quickExitRun();
    expect(Date.now() - started).toBeLessThan(200);
    expect(state.stages).not.toContain('install');
  });

  it('a later run retries after a refused first run, and succeeds', async () => {
    listener = 'refuses';
    await quickExitRun();
    expect(state.stages).not.toContain('install');

    listener = 'answers';
    await quickExitRun();
    expect(fetchDouble).toHaveBeenCalledTimes(2);
    expect(state.stages).toContain('install');
  });

  it('once recorded, no second send - and the run is not held', async () => {
    await quickExitRun();
    fetchDouble.mockClear();
    events.length = 0;
    const started = Date.now();
    await quickExitRun();
    expect(fetchDouble).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(50);
  });
});
