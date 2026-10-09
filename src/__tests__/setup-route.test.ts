import { describe, expect, it } from 'vitest';
import { InvalidEnvError, routeSetup } from '../lib/setup-route.js';
import type { EnvironmentConfig, EnvName } from '../lib/config.js';

/** A store where `tokens` says which envs hold a login. `ALIGN_TOKEN` is folded in by the real
 *  getEnvironment, so a token "from the environment" is just a token on every env here. */
function store(tokens: Partial<Record<EnvName, string>>, defaultEnv: EnvName = 'prod') {
  return {
    getEnvironment: (env: EnvName): EnvironmentConfig =>
      ({ gatewayUrl: '', authToken: tokens[env] ?? null, tenantId: null, mode: 'auth' }),
    getDefaultEnv: (): EnvName => defaultEnv,
  };
}

describe('routeSetup: no login, no env: the solo path', () => {
  it('goes local on a machine with nothing configured', () => {
    expect(routeSetup({}, store({}), {})).toEqual({ kind: 'local' });
  });
  it('an unrelated ALIGN_ENV value does not make it team', () => {
    expect(routeSetup({}, store({}), { ALIGN_ENV: 'local' })).toEqual({ kind: 'local' });
  });
});

describe('routeSetup: a team login means TEAM', () => {
  it('a stored prod token routes to team on prod', () => {
    expect(routeSetup({}, store({ prod: 'tok' }), {})).toEqual({ kind: 'team', env: 'prod' });
  });
  it('a stored preview token routes to team on preview, not prod', () => {
    expect(routeSetup({}, store({ preview: 'tok' }), {})).toEqual({ kind: 'team', env: 'preview' });
  });
  it('the default env wins when both are logged in', () => {
    expect(routeSetup({}, store({ prod: 'a', preview: 'b' }, 'preview'), {})).toEqual({ kind: 'team', env: 'preview' });
  });
  it('--approve alone does not change that (scripted setup is TEAM for a logged-in user)', () => {
    expect(routeSetup({ approve: true }, store({ prod: 'tok' }), {})).toEqual({ kind: 'team', env: 'prod' });
  });
  it('ALIGN_ENV=prod|preview with no stored token is team too (setup then offers the login)', () => {
    expect(routeSetup({}, store({}), { ALIGN_ENV: 'prod' })).toEqual({ kind: 'team', env: 'prod' });
    expect(routeSetup({}, store({}), { ALIGN_ENV: 'preview' })).toEqual({ kind: 'team', env: 'preview' });
  });
});

describe('routeSetup: an explicit flag always wins', () => {
  it('--env prod is team even with no token', () => {
    expect(routeSetup({ env: 'prod' }, store({}), {})).toEqual({ kind: 'team', env: 'prod' });
  });
  it('--env preview beats a prod login', () => {
    expect(routeSetup({ env: 'preview' }, store({ prod: 'tok' }), {})).toEqual({ kind: 'team', env: 'preview' });
  });
  it('--env local with no login is plain local', () => {
    expect(routeSetup({ env: 'local' }, store({}), {})).toEqual({ kind: 'local' });
  });
  it('--env local with a login is local and says the team login is untouched', () => {
    expect(routeSetup({ env: 'local' }, store({ prod: 'tok' }), {})).toEqual({ kind: 'local', teamLoginUntouched: 'prod' });
  });
  it('--local is the same explicit choice as --env local', () => {
    expect(routeSetup({ local: true }, store({ prod: 'tok' }), {})).toEqual({ kind: 'local', teamLoginUntouched: 'prod' });
    expect(routeSetup({ local: true }, store({}), {})).toEqual({ kind: 'local' });
  });
  it('--env local beats ALIGN_ENV=prod', () => {
    expect(routeSetup({ env: 'local' }, store({}), { ALIGN_ENV: 'prod' })).toEqual({ kind: 'local' });
  });
});

describe('routeSetup: an unrecognised --env', () => {
  it.each(['production', 'stage', ''])('rejects %j and lists the valid ones', (bad) => {
    const run = () => routeSetup({ env: bad }, store({}), {});
    expect(run).toThrow(InvalidEnvError);
    expect(run).toThrow(/local, preview, prod/);
  });
});

describe('align login then align setup', () => {
  it('a token written by `align login` (any env) is what routes setup to the team path', () => {
    // login stores the token with setAuthToken(env, ...) and ends "Ready. Run: align setup".
    expect(routeSetup({}, store({ prod: 'fresh-from-login' }), {}).kind).toBe('team');
    expect(routeSetup({ approve: true }, store({ preview: 'fresh-from-login' }), {}).kind).toBe('team');
  });
});
