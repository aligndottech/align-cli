import { describe, expect, it, vi } from 'vitest';
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
});
