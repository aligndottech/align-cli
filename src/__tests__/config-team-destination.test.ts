import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../lib/config.js';

const sets: string[] = [];
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
      set(k: string, v: unknown) { sets.push(k); store[k] = v; }
      has(k: string) { return k in store; }
      delete(k: string) { delete store[k]; }
      clear() { store = { ...this.defaults }; }
    },
  };
});

const EVIL = 'https://evil.example';
const ACME = {
  gatewayUrl: 'https://api.acme.example',
  appUrl: 'https://align.acme.example',
  authToken: ['algt', 'acme', 'token'].join('_'),
  tenantId: 'tenant-acme',
  orgNameClaimed: 'Acme Platform',
};

describe('team destination config (join plan C2)', () => {
  beforeEach(() => {
    sets.length = 0;
    vi.stubEnv('ALIGN_TOKEN', '');
    vi.stubEnv('ALIGN_TENANT_ID', '');
    vi.stubEnv('ALIGN_GATEWAY_URL', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  describe('saveTeamDestination', () => {
    it('stores the whole entry and marks it a team destination', () => {
      const c = createConfigStore();
      c.saveTeamDestination('acme', ACME, new Date('2026-10-11T00:00:00Z'));
      expect(c.hasTeamDestination('acme')).toBe(true);
      expect(c.listTeamDestinationNames()).toEqual(['acme']);
      expect(c.getEnvironment('acme')).toMatchObject({
        gatewayUrl: ACME.gatewayUrl, appUrl: ACME.appUrl, authToken: ACME.authToken, tenantId: 'tenant-acme',
        orgNameClaimed: 'Acme Platform', kind: 'team', mode: 'auth', joinedAt: '2026-10-11T00:00:00.000Z',
      });
    });

    it('writes in ONE store.set, so a crash cannot leave a token without its gateway', () => {
      const c = createConfigStore();
      sets.length = 0;
      c.saveTeamDestination('acme', ACME);
      expect(sets).toEqual(['environments']);
    });

    it.each(['prod', 'a:b', 'Acme', 'x'])('refuses the name %s and writes nothing', (name) => {
      const c = createConfigStore();
      sets.length = 0;
      expect(() => c.saveTeamDestination(name, ACME)).toThrow(/destination name/);
      expect(sets).toEqual([]);
    });

    it('refuses a plain-http gateway or app URL, but takes localhost over http', () => {
      const c = createConfigStore();
      expect(() => c.saveTeamDestination('acme', { ...ACME, gatewayUrl: 'http://api.acme.example' })).toThrow(/https/);
      expect(() => c.saveTeamDestination('acme', { ...ACME, appUrl: 'http://align.acme.example' })).toThrow(/https/);
      expect(c.hasTeamDestination('acme')).toBe(false);
      c.saveTeamDestination('dev', { ...ACME, gatewayUrl: 'http://localhost:8080', appUrl: 'http://localhost:5173' });
      expect(c.hasTeamDestination('dev')).toBe(true);
    });

    it('refuses an empty token', () => {
      const c = createConfigStore();
      expect(() => c.saveTeamDestination('acme', { ...ACME, authToken: '' })).toThrow(/token/);
      expect(c.hasTeamDestination('acme')).toBe(false);
    });

    it('saving a second destination leaves the first and the builtins alone', () => {
      const c = createConfigStore();
      c.setAuthToken('prod', 'prod-token');
      c.saveTeamDestination('acme', ACME);
      c.saveTeamDestination('beta', { ...ACME, tenantId: 'tenant-beta' });
      expect(c.getEnvironment('acme').tenantId).toBe('tenant-acme');
      expect(c.getEnvironment('beta').tenantId).toBe('tenant-beta');
      expect(c.getEnvironment('prod').authToken).toBe('prod-token');
      expect(c.listTeamDestinationNames()).toEqual(['acme', 'beta']);
    });
  });

  describe('getEnvironment ignores the environment variables for a team destination (S4, S5)', () => {
    it('ALIGN_GATEWAY_URL does not redirect a team destination, and still redirects prod', () => {
      const c = createConfigStore();
      c.saveTeamDestination('acme', ACME);
      vi.stubEnv('ALIGN_GATEWAY_URL', EVIL);
      expect(c.getEnvironment('acme').gatewayUrl).toBe(ACME.gatewayUrl);
      expect(c.getEnvironment('prod').gatewayUrl).toBe(EVIL);
    });

    it('ALIGN_TOKEN is never used for a team destination, even when it holds no token, and still fills prod', () => {
      const c = createConfigStore();
      c.saveTeamDestination('acme', { ...ACME, authToken: 'stored' });
      vi.stubEnv('ALIGN_TOKEN', 'from-the-shell');
      expect(c.getEnvironment('acme').authToken).toBe('stored');
      c.clear('acme');
      expect(c.getEnvironment('prod').authToken).toBe('from-the-shell');
    });

    it('a destination whose token was removed reads as logged out, not as the ALIGN_TOKEN of the shell', () => {
      const c = createConfigStore();
      c.saveTeamDestination('acme', ACME);
      c.clearTeamToken('acme');
      vi.stubEnv('ALIGN_TOKEN', 'from-the-shell');
      const e = c.getEnvironment('acme');
      expect(e.authToken).toBeNull();
      expect(e.gatewayUrl).toBe(ACME.gatewayUrl);
    });

    it('ALIGN_TENANT_ID is ignored for a team destination and applies to prod', () => {
      const c = createConfigStore();
      c.saveTeamDestination('acme', ACME);
      vi.stubEnv('ALIGN_TENANT_ID', 'tenant-from-shell');
      expect(c.getEnvironment('acme').tenantId).toBe('tenant-acme');
      expect(c.getEnvironment('prod').tenantId).toBe('tenant-from-shell');
    });

    it('a name that is neither a builtin nor saved throws instead of inventing an entry', () => {
      const c = createConfigStore();
      expect(() => c.getEnvironment('ghost' as never)).toThrow(/ghost/);
    });
  });

  describe('connector tokens cannot collide across destinations (S7)', () => {
    it('acme and prod hold the same connector key separately', () => {
      const c = createConfigStore();
      c.saveTeamDestination('acme', ACME);
      c.setConnectorToken('prod', 'slack', 'prod-slack');
      c.setConnectorToken('acme', 'slack', 'acme-slack');
      expect(c.getConnectorToken('prod', 'slack')).toBe('prod-slack');
      expect(c.getConnectorToken('acme', 'slack')).toBe('acme-slack');
    });

    it('forgetting every connector of "prod-eu" leaves "prod" (a name that starts with it) untouched, and vice versa', () => {
      const c = createConfigStore();
      c.saveTeamDestination('prod-eu', ACME);
      c.setConnectorToken('prod', 'slack', 'prod-slack');
      c.setConnectorToken('prod-eu' as never, 'slack', 'eu-slack');
      c.forgetAllConnectors('prod-eu' as never);
      expect(c.getConnectorToken('prod', 'slack')).toBe('prod-slack');
      expect(c.getConnectorToken('prod-eu' as never, 'slack')).toBeNull();
      c.setConnectorToken('prod-eu' as never, 'slack', 'eu-slack');
      c.forgetAllConnectors('prod');
      expect(c.getConnectorToken('prod-eu' as never, 'slack')).toBe('eu-slack');
    });
  });

  describe('shareDestination', () => {
    it('is unset until chosen, and set only to a saved destination', () => {
      const c = createConfigStore();
      expect(c.getShareDestination()).toBeNull();
      expect(() => c.setShareDestination('acme')).toThrow(/acme/);
      expect(c.getShareDestination()).toBeNull();
      c.saveTeamDestination('acme', ACME);
      c.setShareDestination('acme');
      expect(c.getShareDestination()).toBe('acme');
    });

    it('refuses a builtin name: the share destination is a team destination or nothing', () => {
      const c = createConfigStore();
      expect(() => c.setShareDestination('prod')).toThrow();
    });

    it('can be cleared, and is cleared when its destination is removed (another one stays)', () => {
      const c = createConfigStore();
      c.saveTeamDestination('acme', ACME);
      c.saveTeamDestination('beta', ACME);
      c.setShareDestination('acme');
      c.clear('beta');
      expect(c.getShareDestination()).toBe('acme');
      c.clear('acme');
      expect(c.getShareDestination()).toBeNull();
      // A later join under the same name must not silently become the share target again.
      c.saveTeamDestination('acme', ACME);
      expect(c.getShareDestination()).toBeNull();
      c.setShareDestination('acme');
      c.clearShareDestination();
      expect(c.getShareDestination()).toBeNull();
    });
  });
});
