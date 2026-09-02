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

describe('isFreshInstall across non-default envs (Copilot, PR #224)', () => {
  // isFreshInstall must not read ONLY the default env's token - a user who logged into a
  // non-default env (e.g. preview, while defaultEnv is still prod) is a returning user and
  // must not be routed into the fresh-install flow.
  function multiEnvStore(tokens: Partial<Record<EnvName, string | null>>) {
    return {
      getEnvironment: (env: EnvName): EnvironmentConfig => ({
        gatewayUrl: '',
        authToken: tokens[env] ?? null,
        tenantId: null,
        mode: 'auth',
      }),
      getDefaultEnv: (): EnvName => 'prod',
    };
  }

  it('is false when a cloud token exists on a NON-default env (preview) while defaultEnv stays prod', () => {
    expect(isFreshInstall(multiEnvStore({ prod: null, preview: 'tok' }))).toBe(false);
  });

  it('is still true when no env carries a token at all', () => {
    expect(isFreshInstall(multiEnvStore({}))).toBe(true);
  });
});
