import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Env = { mode: string; authToken: string | null };
let defaultEnv = 'prod';
let envs: Record<string, Env> = {};
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConfigStore: () => ({
    getDefaultEnv: () => defaultEnv,
    getEnvironment: (n: string) => envs[n] ?? { mode: 'auth', authToken: null },
  }),
}));

import { isLocalDefault } from '../lib/launch/launch.js';

beforeEach(() => {
  vi.stubEnv('ALIGN_ENV', undefined);
  defaultEnv = 'prod';
});
afterEach(() => vi.unstubAllEnvs());

describe('isLocalDefault uses the CLI\'s own env resolver', () => {
  it('local-embedded with an unauthenticated cloud default: local', () => {
    envs = { local: { mode: 'local-embedded', authToken: null }, prod: { mode: 'auth', authToken: null } };
    expect(isLocalDefault()).toBe(true);
  });
  it('ALIGN_ENV=prod wins: a no-`--env` entry is NOT local', () => {
    envs = { local: { mode: 'local-embedded', authToken: null }, prod: { mode: 'auth', authToken: null } };
    vi.stubEnv('ALIGN_ENV', 'prod');
    expect(isLocalDefault()).toBe(false);
  });
  it('ALIGN_ENV=local is local even when the user is signed in', () => {
    envs = { local: { mode: 'local-embedded', authToken: null }, prod: { mode: 'auth', authToken: 'tok' } };
    vi.stubEnv('ALIGN_ENV', 'local');
    expect(isLocalDefault()).toBe(true);
  });
  it('a signed-in user is never redirected to local', () => {
    envs = { local: { mode: 'local-embedded', authToken: null }, prod: { mode: 'auth', authToken: 'tok' } };
    expect(isLocalDefault()).toBe(false);
  });
  it('the demo-mode rule: an unauthenticated demo cloud default is not redirected', () => {
    envs = { local: { mode: 'local-embedded', authToken: null }, prod: { mode: 'demo', authToken: null } };
    expect(isLocalDefault()).toBe(false);
  });
});
