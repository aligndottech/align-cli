import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore, hydrateProviderKeyEnv } from '../lib/config.js';

vi.mock('conf', () => {
  let store: Record<string, unknown> = {};
  return {
    default: class {
      private defaults: Record<string, unknown>;
      constructor(opts: { defaults?: Record<string, unknown> }) {
        this.defaults = opts.defaults ?? {};
        store = { ...this.defaults };
      }
      get(k: string) { return store[k]; }
      set(k: string, v: unknown) { store[k] = v; }
      has(k: string) { return k in store; }
      delete(k: string) { delete store[k]; }
      clear() { store = { ...this.defaults }; }
    },
  };
});

describe('config store', () => {
  // ALI-462: getEnvironment reads ALIGN_TOKEN, ALIGN_TENANT_ID and ALIGN_GATEWAY_URL, so
  // without this the outcome depends on whoever runs the suite. Not hypothetical: with
  // ALIGN_TOKEN exported, "clears stored token on logout" fails on the leaked value. The
  // environment is an input, so it belongs in the arrange step like any other.
  beforeEach(() => {
    vi.stubEnv('ALIGN_TOKEN', '');
    vi.stubEnv('ALIGN_TENANT_ID', '');
    vi.stubEnv('ALIGN_GATEWAY_URL', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('stores, reads and clears the chosen launch agent', () => {
    const c = createConfigStore();
    expect(c.getAgent()).toBeUndefined();
    c.setAgent('claude-code');
    expect(c.getAgent()).toBe('claude-code');
    c.clearAgent();
    expect(c.getAgent()).toBeUndefined();
  });

  it('returns default gateway URL for local', () => {
    expect(createConfigStore().getEnvironment('local').gatewayUrl).toBe('http://localhost:8080');
  });

  it('returns default gateway URL for preview', () => {
    expect(createConfigStore().getEnvironment('preview').gatewayUrl).toBe('https://api.preview.align.tech');
  });

  it('returns default gateway URL for prod', () => {
    expect(createConfigStore().getEnvironment('prod').gatewayUrl).toBe('https://api.align.tech');
  });

  it('saves and retrieves auth token per env', () => {
    const c = createConfigStore();
    c.setAuthToken('preview', 'tok_abc');
    expect(c.getEnvironment('preview').authToken).toBe('tok_abc');
  });

  it('saves and retrieves tenant ID per env', () => {
    const c = createConfigStore();
    c.setTenantId('local', 'tenant-uuid');
    expect(c.getEnvironment('local').tenantId).toBe('tenant-uuid');
  });

  it('saves and retrieves ngrok URL', () => {
    const c = createConfigStore();
    c.setNgrokUrl('https://abc.ngrok-free.app');
    expect(c.getEnvironment('local').ngrokUrl).toBe('https://abc.ngrok-free.app');
  });

  it('defaults to prod env', () => {
    expect(createConfigStore().getDefaultEnv()).toBe('prod');
  });

  it('clears stored token on logout', () => {
    const c = createConfigStore();
    c.setAuthToken('prod', 'tok_123');
    expect(c.getEnvironment('prod').authToken).toBe('tok_123');
    c.clear('prod');
    expect(c.getEnvironment('prod').authToken).toBeNull();
  });

  // ALI-462: the state at the heart of the ticket is representable. No CLI flow produces it
  // (login-flow sets the token first and the tenant only after /me succeeds), so it is
  // reachable ONLY like this. Pinned because the guard downstream is written against it.
  it('ALIGN_TENANT_ID with no ALIGN_TOKEN yields a tenant that nothing authenticates', () => {
    vi.stubEnv('ALIGN_TENANT_ID', 'tenant-from-env');

    const env = createConfigStore().getEnvironment('prod');

    expect(env.tenantId).toBe('tenant-from-env');
    expect(env.authToken).toBeNull();
    // `auth` is what makes it unusable. The same shape under `demo` is how a local gateway
    // is meant to be addressed, which is why the client guard keys on mode, not on this.
    expect(env.mode).toBe('auth');
  });

  it('saves and retrieves connector cloudId', () => {
    const c = createConfigStore();
    c.setConnectorCloudId('prod', 'jira', 'a1b2c3-cloud-id');
    expect(c.getConnectorCloudId('prod', 'jira')).toBe('a1b2c3-cloud-id');
  });

  it('returns null for unknown connector cloudId', () => {
    const c = createConfigStore();
    expect(c.getConnectorCloudId('prod', 'confluence')).toBeNull();
  });

  it('cloudId is scoped per env and connector', () => {
    const c = createConfigStore();
    c.setConnectorCloudId('prod', 'jira', 'prod-cloud-id');
    c.setConnectorCloudId('preview', 'jira', 'preview-cloud-id');
    expect(c.getConnectorCloudId('prod', 'jira')).toBe('prod-cloud-id');
    expect(c.getConnectorCloudId('preview', 'jira')).toBe('preview-cloud-id');
  });

  // ALI-1284: a free-tier provider key collected during `align setup` has to survive to the
  // NEXT invocation of `align ask`, which only reads `process.env` (local-llm.ts stays a pure
  // env-reader on purpose, so it is testable without filesystem I/O). So the key is persisted
  // here, the same way a local connector's read-only token already is, and hydrated back into
  // process.env at CLI startup - see hydrateProviderKeyEnv below.
  describe('provider keys (ALI-1284)', () => {
    it('returns null for a provider with no stored key', () => {
      expect(createConfigStore().getProviderKey('groq')).toBeNull();
    });

    it('saves and retrieves a provider key', () => {
      const c = createConfigStore();
      c.setProviderKey('groq', 'gsk_abc');
      expect(c.getProviderKey('groq')).toBe('gsk_abc');
    });

    it('keeps groq and gemini keys distinct', () => {
      const c = createConfigStore();
      c.setProviderKey('groq', 'gsk_groq');
      c.setProviderKey('gemini', 'gem_key');
      expect(c.getProviderKey('groq')).toBe('gsk_groq');
      expect(c.getProviderKey('gemini')).toBe('gem_key');
    });

    it('clears a stored key so hydration has nothing left to re-apply', () => {
      const c = createConfigStore();
      c.setProviderKey('groq', 'gsk_groq');
      c.clearProviderKey('groq');
      expect(c.getProviderKey('groq')).toBeNull();
    });

    it('clearing one provider leaves the other untouched', () => {
      const c = createConfigStore();
      c.setProviderKey('groq', 'gsk_groq');
      c.setProviderKey('gemini', 'gem_key');
      c.clearProviderKey('groq');
      expect(c.getProviderKey('groq')).toBeNull();
      expect(c.getProviderKey('gemini')).toBe('gem_key');
    });
  });

  // ALI-618: install id and telemetry consent are global to the machine, not per-env - a
  // local-only user has no `environments` entry to hang either off (unlike authToken/tenantId).
  describe('anonymous local telemetry state', () => {
    it('generates a v4 UUID install id on first read', () => {
      const id = createConfigStore().getInstallId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('is stable across repeated reads', () => {
      const c = createConfigStore();
      const first = c.getInstallId();
      const second = c.getInstallId();
      expect(second).toBe(first);
    });

    it('has no telemetry consent recorded by default', () => {
      expect(createConfigStore().getTelemetryConsent()).toBeUndefined();
    });

    it('persists a granted consent decision', () => {
      const c = createConfigStore();
      c.setTelemetryConsent('granted');
      expect(c.getTelemetryConsent()).toBe('granted');
    });

    // Second example for the same rule: pins that the value is read back, not just truthy.
    it('persists a declined consent decision distinctly from granted', () => {
      const c = createConfigStore();
      c.setTelemetryConsent('declined');
      expect(c.getTelemetryConsent()).toBe('declined');
    });
  });

  // ALI-1284: run at real process startup (src/index.ts), before any command runs - a pure
  // function over an env object rather than mutating process.env itself, so it stays testable
  // the way migrateConfigDirectory does (no hidden global state in the function under test).
  describe('hydrateProviderKeyEnv', () => {
    const fakeConfig = (keys: Partial<Record<'groq' | 'gemini', string>>) => ({
      getProviderKey: (p: 'groq' | 'gemini') => keys[p] ?? null,
    });

    it('sets GROQ_API_KEY from a stored key when the env var is unset', () => {
      const env: Record<string, string | undefined> = {};
      hydrateProviderKeyEnv(fakeConfig({ groq: 'gsk_stored' }), env);
      expect(env['GROQ_API_KEY']).toBe('gsk_stored');
    });

    it('sets GEMINI_API_KEY from a stored key when the env var is unset', () => {
      const env: Record<string, string | undefined> = {};
      hydrateProviderKeyEnv(fakeConfig({ gemini: 'gem_stored' }), env);
      expect(env['GEMINI_API_KEY']).toBe('gem_stored');
    });

    // The second example for the same rule: a real env var must win, never be overwritten by
    // a stored convenience default - otherwise a user who deliberately rotates their own
    // GROQ_API_KEY for one shell session would silently get the stale stored one instead.
    it('never overwrites a real env var already set, even with a different stored value', () => {
      const env: Record<string, string | undefined> = { GROQ_API_KEY: 'from-the-shell' };
      hydrateProviderKeyEnv(fakeConfig({ groq: 'gsk_stored' }), env);
      expect(env['GROQ_API_KEY']).toBe('from-the-shell');
    });

    it('leaves the env untouched when nothing is stored', () => {
      const env: Record<string, string | undefined> = {};
      hydrateProviderKeyEnv(fakeConfig({}), env);
      expect(env['GROQ_API_KEY']).toBeUndefined();
      expect(env['GEMINI_API_KEY']).toBeUndefined();
    });

    // Copilot review, PR #322: keyForProvider('gemini') in local-llm.ts accepts
    // GOOGLE_API_KEY as a real alias for GEMINI_API_KEY. Hydrating a stored key into
    // GEMINI_API_KEY while the user has deliberately set GOOGLE_API_KEY would make the
    // stored (possibly stale) value win keyForProvider's own `||`, silently shadowing a
    // real credential the user just set.
    it('does not hydrate a stored Gemini key over a real GOOGLE_API_KEY alias', () => {
      const env: Record<string, string | undefined> = { GOOGLE_API_KEY: 'real-google-key' };
      hydrateProviderKeyEnv(fakeConfig({ gemini: 'stale-stored-key' }), env);
      expect(env['GEMINI_API_KEY']).toBeUndefined();
      expect(env['GOOGLE_API_KEY']).toBe('real-google-key');
    });
  });
});
