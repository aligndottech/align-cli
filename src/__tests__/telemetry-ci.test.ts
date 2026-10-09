/**
 * C6: nothing is sent from CI. `inCi()` answers from ci-info's own vendor table and predicate,
 * evaluated on every call - ci-info's `isCI` export is computed once at import, so a test runner
 * started with CI=true (every CI run) could never stub it back to false.
 *
 * The parity half asks the real ci-info, in a fresh child process per case, the same question
 * under the same environment, so a predicate that drifts from ci-info's fails here.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inCi } from '../lib/telemetry-ci.js';

const require = createRequire(import.meta.url);
const CI_INFO = require.resolve('ci-info');
const vendors = require('ci-info/vendors.json') as Array<{ env: unknown }>;

/** Every variable ci-info can read, so each case starts from a clean slate. */
const GENERIC = ['CI', 'BUILD_ID', 'BUILD_NUMBER', 'CI_APP_ID', 'CI_BUILD_ID', 'CI_BUILD_NUMBER', 'CI_NAME', 'CONTINUOUS_INTEGRATION', 'RUN_ID'];
function namesIn(e: unknown): string[] {
  if (typeof e === 'string') return [e];
  if (Array.isArray(e)) return e.flatMap(namesIn);
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if ('env' in o && typeof o['env'] === 'string') return [o['env']];
    if ('any' in o && Array.isArray(o['any'])) return o['any'] as string[];
    return Object.keys(o);
  }
  return [];
}
const ALL_KEYS = [...new Set([...GENERIC, ...vendors.flatMap((v) => namesIn(v.env))])];

function ciInfoSays(extra: Record<string, string>): boolean {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !ALL_KEYS.includes(k)) env[k] = v;
  const out = execFileSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(CI_INFO)}).isCI))`], {
    env: { ...env, ...extra },
  });
  return out.toString() === 'true';
}

describe('inCi', () => {
  beforeEach(() => {
    for (const k of ALL_KEYS) vi.stubEnv(k, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('positive control: the key list covers GitHub Actions and the generic CI flag', () => {
    expect(ALL_KEYS).toContain('GITHUB_ACTIONS');
    expect(ALL_KEYS).toContain('CI');
    expect(vendors.length).toBeGreaterThan(20);
  });

  it('is false on a laptop and true under CI=true or GITHUB_ACTIONS=true', () => {
    expect(inCi()).toBe(false);
    vi.stubEnv('CI', 'true');
    expect(inCi()).toBe(true);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    expect(inCi()).toBe(true);
  });

  it('reads the environment on every call, not once at import', () => {
    vi.stubEnv('CI', 'true');
    expect(inCi()).toBe(true);
    vi.stubEnv('CI', undefined);
    expect(inCi()).toBe(false);
  });

  it.each<[string, Record<string, string>]>([
    ['nothing', {}],
    ['CI=true', { CI: 'true' }],
    ['CI=false overrides a vendor', { CI: 'false', GITHUB_ACTIONS: 'true' }],
    ['GitHub Actions', { GITHUB_ACTIONS: 'true' }],
    ['Jenkins BUILD_NUMBER', { BUILD_NUMBER: '7' }],
    ['GitLab', { GITLAB_CI: 'true' }],
    ['Buildkite', { BUILDKITE: 'true' }],
    ['an empty CI', { CI: '' }],
  ])('agrees with ci-info for %s', (_label, extra) => {
    for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
    expect(inCi()).toBe(ciInfoSays(extra));
  });
});
