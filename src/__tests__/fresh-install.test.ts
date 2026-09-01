/**
 * ALI-794: whether `align setup` is running on a machine with NOTHING configured
 * yet, which is what gates the value-first onboarding order (component 1). A
 * returning user (either mode already set up) keeps today's mode-question-first
 * flow untouched - this predicate is the fork point between the two.
 */
import { describe, expect, it } from 'vitest';
import { isFreshInstall } from '../lib/config.js';
import type { EnvironmentConfig, EnvName } from '../lib/config.js';

function store(over: { localMode?: EnvironmentConfig['mode']; cloudToken?: string | null }) {
  return {
    getEnvironment: (env: EnvName): EnvironmentConfig => {
      if (env === 'local') {
        return { gatewayUrl: '', authToken: null, tenantId: null, mode: over.localMode ?? 'demo' };
      }
      return { gatewayUrl: '', authToken: over.cloudToken ?? null, tenantId: null, mode: 'auth' };
    },
    getDefaultEnv: (): EnvName => 'prod',
  };
}

describe('isFreshInstall', () => {
  it('is true when neither local mode nor a cloud token is configured', () => {
    expect(isFreshInstall(store({}))).toBe(true);
  });

  it('is false once a cloud token exists', () => {
    expect(isFreshInstall(store({ cloudToken: 'tok' }))).toBe(false);
  });

  it('is false once local-embedded mode is already set up', () => {
    expect(isFreshInstall(store({ localMode: 'local-embedded' }))).toBe(false);
  });

  it('is false when both are configured', () => {
    expect(isFreshInstall(store({ localMode: 'local-embedded', cloudToken: 'tok' }))).toBe(false);
  });
});
