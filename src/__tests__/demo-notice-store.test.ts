/**
 * `align demo` shows the telemetry notice on a first terminal run, but opening the config store creates
 * ~/.align and migrates an older config, which `demo` promised not to do for anyone who will not see
 * the notice. REAL store here (HOME is isolated by the vitest setup file), so the directory is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
import { alignConfigDir } from '../lib/private-files.js';
import { beginInvocationTelemetry } from '../lib/usage-telemetry.js';
import { DOCTOR_ENV } from '../lib/telemetry-env.js';

function setTTY(v: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: v, configurable: true });
}

describe('align demo and the config folder', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTelemetryEnv();
    delete process.env[DOCTOR_ENV];
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
    delete process.env[DOCTOR_ENV];
    vi.unstubAllEnvs();
    delete (process.stdin as { isTTY?: boolean }).isTTY;
    delete (process.stderr as { isTTY?: boolean }).isTTY;
  });

  it('positive control: a terminal run with no opt-out prints the notice and creates the folder', async () => {
    setTTY(true);
    await beginInvocationTelemetry('demo', { hook: false });
    expect(existsSync(alignConfigDir())).toBe(true);
    expect(stderr.mock.calls.some((c) => String(c[0]).includes('anonymous usage counts'))).toBe(true);
  });
});

describe('align demo creates nothing for a run that will not print the notice', () => {
  beforeEach(() => { clearTelemetryEnv(); delete process.env[DOCTOR_ENV]; });
  afterEach(() => {
    delete process.env[DOCTOR_ENV];
    vi.unstubAllEnvs();
    delete (process.stdin as { isTTY?: boolean }).isTTY;
    delete (process.stderr as { isTTY?: boolean }).isTTY;
  });

  it.each([
    ['no terminal', () => setTTY(false)],
    ['DO_NOT_TRACK', () => { setTTY(true); vi.stubEnv('DO_NOT_TRACK', '1'); }],
    ['ALIGN_TELEMETRY=0', () => { setTTY(true); vi.stubEnv('ALIGN_TELEMETRY', '0'); }],
    ['CI', () => { setTTY(true); vi.stubEnv('CI', 'true'); }],
  ])('%s', async (_label, arrange) => {
    // Own the precondition: the folder must be absent before, or "still absent" proves nothing.
    // (The previous describe's positive control created it in this same isolated HOME.)
    const { rmSync } = await import('node:fs');
    rmSync(alignConfigDir(), { recursive: true, force: true });
    expect(existsSync(alignConfigDir())).toBe(false);
    arrange();
    await beginInvocationTelemetry('demo', { hook: false });
    expect(existsSync(alignConfigDir())).toBe(false);
  });
});
