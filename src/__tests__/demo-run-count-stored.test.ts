/**
 * The demo count honours a STORED `align telemetry off`, read-only.
 *
 * The seed is the real writer (`createConfigStore().setTelemetryConsent('off')`, what
 * `align telemetry off` calls) run against a temp HOME, so the file shape is the real one.
 * The count must read that file without creating, writing or migrating anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
import { createConfigStore } from '../lib/config.js';
import { recordDemoRun } from '../lib/usage-telemetry.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
let home: string;

beforeEach(() => {
  clearTelemetryEnv();
  home = mkdtempSync(join(tmpdir(), 'align-demo-stored-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 201 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const run = { success: true, durationMs: 1000 };

describe('the demo run count and the stored telemetry answer', () => {
  it.each(['off', 'declined'] as const)('sends nothing when the stored answer is %s', async (answer) => {
    createConfigStore().setTelemetryConsent(answer);
    expect(existsSync(join(home, '.align', 'config.json'))).toBe(true); // positive control: the seed exists
    await recordDemoRun(run);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still sends when the stored answer is granted, and changes nothing on disk', async () => {
    createConfigStore().setTelemetryConsent('granted');
    const before = readFileTree(home);
    await recordDemoRun(run);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(readFileTree(home)).toEqual(before);
  });

  it('with no config at all: sent, and ~/.align is not created', async () => {
    await recordDemoRun(run);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(existsSync(join(home, '.align'))).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });

  it('a config with no telemetryConsent key (an answer never given) is counted', async () => {
    mkdirSync(join(home, '.align'));
    writeFileSync(join(home, '.align', 'config.json'), '{"defaultEnv":"prod"}');
    await recordDemoRun(run);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // Fail closed: a file that exists but cannot be understood might hold an `off`, so nobody is counted.
  it.each([
    ['not json', '{{{ nope'],
    ['a non-object', '[1,2]'],
    ['an unknown value', '{"telemetryConsent":"banana"}'],
    ['an empty file', ''],
  ])('an unreadable config (%s) sends nothing', async (_l, content) => {
    mkdirSync(join(home, '.align'));
    writeFileSync(join(home, '.align', 'config.json'), content);
    await recordDemoRun(run);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a config path that is a directory does not throw and sends nothing', async () => {
    mkdirSync(join(home, '.align', 'config.json'), { recursive: true });
    await expect(recordDemoRun(run)).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

function readFileTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}
