/**
 * `align demo` sends ONE anonymous run count, from the parent process, after the demo finishes.
 *
 * Test list (written first):
 *  - the body is exactly {command, cliVersion, stage, os, success, durationSeconds}: no install id,
 *    no repo, path, hostname or text, and the duration is whole seconds
 *  - a failed run is sent too, with success false
 *  - not sent under DO_NOT_TRACK, ALIGN_TELEMETRY=0, or CI; each variable set explicitly, on and off
 *  - nothing is written to disk and ~/.align is never created or read (the config store is not opened)
 *  - a hanging endpoint costs no more than TELEMETRY_TIMEOUT_MS and does not change the exit code;
 *    a refusing or throwing one changes nothing either
 *  - the `demo` command wires it: one send per run, after runDemo, with runDemo's own exit code kept
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';

const createConfigStore = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('the demo count must never open the config store (it lives in ~/.align)');
  }),
);
vi.mock('../lib/config.js', () => ({ createConfigStore, ALIGN_HOSTED_GATEWAY_URL: 'https://api.align.tech' }));

const runDemo = vi.hoisted(() => vi.fn());
vi.mock('../lib/demo/run.js', () => ({ runDemo: (...a: unknown[]) => runDemo(...a) }));

import pkg from '../../package.json' with { type: 'json' };
import { recordDemoRun, TELEMETRY_TIMEOUT_MS } from '../lib/usage-telemetry.js';
import { registerDemoCommand } from '../commands/demo.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

let home: string;
beforeEach(() => {
  clearTelemetryEnv();
  home = mkdtempSync(join(tmpdir(), 'align-demo-count-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 201 });
  createConfigStore.mockClear();
  runDemo.mockReset();
  process.exitCode = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  process.exitCode = undefined;
});

const sentBody = (): Record<string, unknown> => JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body) as Record<string, unknown>;

describe('the demo run count: what is sent', () => {
  it('sends exactly the allowed fields to the anonymous endpoint, with no install id', async () => {
    await recordDemoRun({ success: true, durationMs: 14_400 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe('https://api.align.tech/telemetry/anonymous');
    expect(sentBody()).toEqual({
      command: 'demo',
      cliVersion: pkg.version,
      stage: 'demo_run',
      os: process.platform,
      success: true,
      durationSeconds: 14,
    });
  });

  it('sends a failed run too, rounding the duration to whole seconds', async () => {
    await recordDemoRun({ success: false, durationMs: 2_600 });
    expect(sentBody()).toMatchObject({ success: false, durationSeconds: 3 });
  });

  it('sends nothing but the body: no Authorization, no tenant header', async () => {
    await recordDemoRun({ success: true, durationMs: 1000 });
    const init = mockFetch.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(Object.keys(init.headers)).toEqual(['Content-Type']);
  });
});

describe('the demo run count: when it is not sent', () => {
  it.each([
    ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }],
    ['ALIGN_TELEMETRY=0', { ALIGN_TELEMETRY: '0' }],
    ['CI=true', { CI: 'true' }],
    ['GITHUB_ACTIONS=true', { GITHUB_ACTIONS: 'true' }],
  ])('is not sent under %s', async (_label, vars) => {
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
    await recordDemoRun({ success: true, durationMs: 1000 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('control: with every switch forced off it IS sent (the cases above are not vacuous)', async () => {
    vi.stubEnv('DO_NOT_TRACK', undefined);
    vi.stubEnv('ALIGN_TELEMETRY', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('GITHUB_ACTIONS', undefined);
    await recordDemoRun({ success: true, durationMs: 1000 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('the demo run count: the disk', () => {
  it('opens no config store and creates nothing under HOME', async () => {
    await recordDemoRun({ success: true, durationMs: 1000 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(createConfigStore).not.toHaveBeenCalled();
    expect(existsSync(join(home, '.align'))).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('the demo run count: bounded and never fatal', () => {
  it('gives up on a hanging endpoint after TELEMETRY_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(() => new Promise(() => {}));
    let done = false;
    const p = recordDemoRun({ success: true, durationMs: 1000 }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(TELEMETRY_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(done).toBe(true);
  });

  it.each([
    ['a network error', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['a 400', () => Promise.resolve({ ok: false, status: 400 })],
    ['a synchronous throw', () => { throw new Error('boom'); }],
  ])('swallows %s', async (_l, impl) => {
    mockFetch.mockImplementation(impl);
    await expect(recordDemoRun({ success: true, durationMs: 1000 })).resolves.toBeUndefined();
  });
});

describe('the demo command', () => {
  const runCli = async (): Promise<void> => {
    const program = new Command().exitOverride();
    registerDemoCommand(program);
    await program.parseAsync(['node', 'align', 'demo']);
  };

  it('sends one count after the demo finishes, success when runDemo returns 0', async () => {
    runDemo.mockResolvedValue(0);
    await runCli();
    expect(runDemo).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentBody()).toMatchObject({ stage: 'demo_run', success: true });
    expect(process.exitCode).toBe(0);
  });

  it('reports failure, and keeps runDemo\'s exit code, when the demo returns 1', async () => {
    runDemo.mockResolvedValue(1);
    await runCli();
    expect(sentBody()).toMatchObject({ success: false });
    expect(process.exitCode).toBe(1);
  });

  it('sends only after runDemo has finished', async () => {
    const order: string[] = [];
    runDemo.mockImplementation(async () => { order.push('demo'); return 0; });
    mockFetch.mockImplementation(async () => { order.push('send'); return { ok: true }; });
    await runCli();
    expect(order).toEqual(['demo', 'send']);
  });

  it('a hanging endpoint changes neither the exit code nor adds more than the timeout', async () => {
    vi.useFakeTimers();
    runDemo.mockResolvedValue(0);
    mockFetch.mockImplementation(() => new Promise(() => {}));
    let done = false;
    const p = runCli().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(TELEMETRY_TIMEOUT_MS + 1);
    await p;
    expect(done).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('a failing endpoint changes no exit code', async () => {
    runDemo.mockResolvedValue(1);
    mockFetch.mockRejectedValue(new Error('down'));
    await runCli();
    expect(process.exitCode).toBe(1);
  });

  it('a demo that throws counts as a failed run, and the throw still surfaces', async () => {
    runDemo.mockRejectedValue(new Error('crash'));
    await expect(runCli()).rejects.toThrow('crash');
    expect(sentBody()).toMatchObject({ stage: 'demo_run', success: false });
  });
});
