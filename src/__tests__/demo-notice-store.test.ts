/**
 * `align demo` shows the telemetry notice on a first terminal run, but opening the config store creates
 * ~/.align and migrates an older config, which `demo` promised not to do for anyone who will not see
 * the notice. REAL store here (HOME is isolated by the vitest setup file), so the directory is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
import { alignConfigDir } from '../lib/private-files.js';
import { migrateConfigDirectory } from '../lib/config.js';
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

  it('positive control: with a config.json already there, a terminal run prints the notice once and marks it', async () => {
    mkdirSync(alignConfigDir(), { recursive: true });
    writeFileSync(join(alignConfigDir(), 'config.json'), '{}');
    setTTY(true);
    await beginInvocationTelemetry('demo', { hook: false });
    await beginInvocationTelemetry('demo', { hook: false });
    const notices = stderr.mock.calls.filter((c) => String(c[0]).includes('anonymous usage counts'));
    expect(notices).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(alignConfigDir(), 'config.json'), 'utf8'))).toHaveProperty('telemetryNoticeShownAt');
  });

  it('with NO config.json it prints nothing and creates nothing, so a legacy config still migrates on the next real command', async () => {
    rmSync(alignConfigDir(), { recursive: true, force: true });
    const legacy = join(tmpdir(), `align-legacy-${process.pid}-${Date.now()}`);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'config.json'), JSON.stringify({ telemetryConsent: 'off', marker: 'legacy-settings' }));
    setTTY(true);
    await beginInvocationTelemetry('demo', { hook: false });
    expect(existsSync(join(alignConfigDir(), 'config.json'))).toBe(false);
    expect(stderr.mock.calls.some((c) => String(c[0]).includes('anonymous usage counts'))).toBe(false);
    migrateConfigDirectory(legacy, alignConfigDir());
    expect(JSON.parse(readFileSync(join(alignConfigDir(), 'config.json'), 'utf8'))).toMatchObject({ marker: 'legacy-settings', telemetryConsent: 'off' });
    rmSync(legacy, { recursive: true, force: true });
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
    rmSync(alignConfigDir(), { recursive: true, force: true });
    expect(existsSync(alignConfigDir())).toBe(false);
    arrange();
    await beginInvocationTelemetry('demo', { hook: false });
    expect(existsSync(alignConfigDir())).toBe(false);
  });
});
