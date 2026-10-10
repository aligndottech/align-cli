/**
 * An explicit env opt-out (DO_NOT_TRACK, ALIGN_TELEMETRY) is stored, so a process that never sees
 * the variable (an MCP server with a trimmed env, the detached sync child, a hook) still honours
 * it. Bare CI is not a user choice and is never stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTelemetryEnv } from './helpers/telemetry-env.js';
import { storeEnvOptOut } from '../lib/telemetry-consent.js';
import { getTelemetryStatus } from '../lib/usage-telemetry.js';

vi.mock('conf', () => {
  let store: Record<string, unknown> = {};
  return {
    default: class {
      constructor(opts: { defaults?: Record<string, unknown> }) { store = { ...(opts.defaults ?? {}) }; }
      get(k: string) { return store[k]; }
      set(k: string, v: unknown) { store[k] = v; }
      has(k: string) { return k in store; }
      delete(k: string) { delete store[k]; }
      clear() { store = {}; }
    },
  };
});
import { createConfigStore, type TelemetryConsent } from '../lib/config.js';

function fakeStore(initial: TelemetryConsent | undefined) {
  const s = { consent: initial, via: undefined as string | undefined };
  return {
    s,
    getTelemetryConsent: () => s.consent,
    setTelemetryOffByEnv: (via: string) => { s.consent = 'off'; s.via = via; },
  };
}

beforeEach(() => clearTelemetryEnv());
afterEach(() => vi.unstubAllEnvs());

describe('storeEnvOptOut', () => {
  it.each([['DO_NOT_TRACK', '1'], ['DO_NOT_TRACK', 'true'], ['ALIGN_TELEMETRY', '0']])('%s=%s is stored as off, naming the variable', (name, value) => {
    vi.stubEnv(name, value);
    const f = fakeStore(undefined);
    expect(storeEnvOptOut(f)).toBe(true);
    expect(f.s).toEqual({ consent: 'off', via: name });
  });
  it('overrides a stored granted', () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    const f = fakeStore('granted');
    storeEnvOptOut(f);
    expect(f.s.consent).toBe('off');
  });
  it.each(['off', 'declined'] as const)('leaves a stored %s alone (no reason overwrite)', (c) => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    const f = fakeStore(c);
    expect(storeEnvOptOut(f)).toBe(false);
    expect(f.s).toEqual({ consent: c, via: undefined });
  });
  it('stores nothing when neither switch is set, and nothing for DO_NOT_TRACK=0 or ALIGN_TELEMETRY=1', () => {
    const f = fakeStore(undefined);
    expect(storeEnvOptOut(f)).toBe(false);
    vi.stubEnv('DO_NOT_TRACK', '0');
    vi.stubEnv('ALIGN_TELEMETRY', '1');
    expect(storeEnvOptOut(f)).toBe(false);
    expect(f.s.consent).toBeUndefined();
  });
  it('bare CI is not a user choice and is never stored', () => {
    vi.stubEnv('CI', 'true');
    const f = fakeStore(undefined);
    expect(storeEnvOptOut(f)).toBe(false);
    expect(f.s.consent).toBeUndefined();
  });
  it('a store that throws costs nothing', () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    expect(storeEnvOptOut({ getTelemetryConsent: () => { throw new Error('x'); }, setTelemetryOffByEnv: () => {} })).toBe(false);
  });
});

describe('the real config store', () => {
  it('records off with its reason and date, and `telemetry on` (setTelemetryConsent) clears all of it', () => {
    const c = createConfigStore();
    c.setTelemetryOffByEnv('DO_NOT_TRACK', new Date('2026-10-10T08:00:00Z'));
    expect(c.getTelemetryConsent()).toBe('off');
    expect(c.getTelemetryOffByEnv()).toEqual({ via: 'DO_NOT_TRACK', at: '2026-10-10T08:00:00.000Z' });
    c.setTelemetryConsent('granted');
    expect(c.getTelemetryConsent()).toBe('granted');
    expect(c.getTelemetryOffByEnv()).toBeUndefined();
  });
  it('`telemetry off` typed by hand carries no env reason', () => {
    const c = createConfigStore();
    c.setTelemetryOffByEnv('DO_NOT_TRACK');
    c.setTelemetryConsent('off');
    expect(c.getTelemetryOffByEnv()).toBeUndefined();
  });
});

describe('telemetry status for a sticky opt-out', () => {
  const local = { gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded' as const };
  const cloud = { gatewayUrl: 'http://x', authToken: 't', tenantId: 'tn', mode: 'auth' as const };
  it.each([local, cloud])('says what set it, when, and how to undo it (%#)', (env) => {
    const st = getTelemetryStatus(env, 'off', true, { via: 'DO_NOT_TRACK', at: '2026-10-10T08:00:00.000Z' });
    expect(st.enabled).toBe(false);
    expect(st.reason).toBe('off (DO_NOT_TRACK was set on 2026-10-10); turn it back on with: align telemetry on');
  });
  it('a hand-typed off keeps its own wording', () => {
    expect(getTelemetryStatus(local, 'off', true).reason).toContain('you ran `align telemetry off`');
  });
  it('the variable itself, while set, still wins the wording', () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    expect(getTelemetryStatus(local, 'off', true, { via: 'DO_NOT_TRACK', at: '2026-10-10T08:00:00.000Z' }).reason).toContain('DO_NOT_TRACK is set');
  });
});
