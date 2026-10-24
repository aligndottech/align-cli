/**
 * A doctor run changes nothing about the user's telemetry choice. Sending nothing is
 * pinned end to end in doctor-e2e.test.ts; this pins the half that has no network trace: the
 * writes to the user's config. Each test is written to go red when its own line is removed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConfigStore } from '../lib/config.js';
import { storeEnvOptOut } from '../lib/telemetry-consent.js';
import { beginInvocationTelemetry } from '../lib/usage-telemetry.js';
import { DOCTOR_ENV } from '../lib/telemetry-env.js';

const KEYS = [DOCTOR_ENV, 'DO_NOT_TRACK', 'ALIGN_TELEMETRY', 'CI', 'ALIGN_WRAPPED'];
let saved: Record<string, string | undefined>;
let tty: { stdin?: PropertyDescriptor; stderr?: PropertyDescriptor };

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env['CI'] = 'false'; // not a CI run, whatever runs this suite
  tty = { stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), stderr: Object.getOwnPropertyDescriptor(process.stderr, 'isTTY') };
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const [name, d] of [['stdin', tty.stdin], ['stderr', tty.stderr]] as const) {
    if (d) Object.defineProperty(process[name], 'isTTY', d); else delete (process[name] as { isTTY?: boolean }).isTTY;
  }
});

describe('a doctor run leaves the telemetry choice alone', () => {
  it('as the first command on a terminal: no notice marked, no install beacon consumed', async () => {
    const sent = await beginInvocationTelemetry('doctor', { hook: false });
    expect(sent).toBe(false);
    const c = createConfigStore();
    expect(c.getTelemetryNoticeShownAt()).toBeUndefined();
    expect(c.wasFunnelStageRecorded('install')).toBe(false);
    expect(c.getTelemetryConsent()).toBeUndefined();
  });

  it('CONTROL: the same call for an ordinary command on that terminal DOES mark the notice', async () => {
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((t: string) => { written.push(t); return true; }) as typeof process.stderr.write;
    try {
      await beginInvocationTelemetry('status', { hook: false });
    } finally {
      process.stderr.write = orig;
    }
    expect(createConfigStore().getTelemetryNoticeShownAt()).toBeDefined();
  });

  it('marks the process, so the rest of the run (and a child) sends nothing', async () => {
    await beginInvocationTelemetry('doctor', { hook: false });
    expect(process.env[DOCTOR_ENV]).toBe('1');
  });
});

describe('storeEnvOptOut in a doctor-marked process (the align mcp child)', () => {
  const store = () => {
    const calls: string[] = [];
    return { calls, s: { getTelemetryConsent: () => undefined, setTelemetryOffByEnv: (via: string) => { calls.push(via); } } };
  };
  it('stores nothing even when the user exported DO_NOT_TRACK', () => {
    process.env['DO_NOT_TRACK'] = '1';
    process.env[DOCTOR_ENV] = '1';
    const { calls, s } = store();
    expect(storeEnvOptOut(s)).toBe(false);
    expect(calls).toEqual([]);
  });
  it('CONTROL: the same process unmarked stores the opt-out', () => {
    process.env['DO_NOT_TRACK'] = '1';
    const { calls, s } = store();
    expect(storeEnvOptOut(s)).toBe(true);
    expect(calls).toEqual(['DO_NOT_TRACK']);
  });
});
