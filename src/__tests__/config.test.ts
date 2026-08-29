import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../lib/config.js';

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
});
