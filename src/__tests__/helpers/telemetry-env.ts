/**
 * C6: every variable that changes what telemetry does, cleared for a test. Built from ci-info's
 * own vendor table plus its generic flags rather than a hand list: the runner a suite lands on
 * may be Buildkite or Jenkins, not GitHub, and any CI variable left set turns telemetry off and
 * inverts the suite (tdd.md, "a test must establish its own preconditions"). Plus the env
 * switches, ALIGN_WRAPPED (a run inside a launched agent), the ALIGN_* variables that put a
 * cloud token or a non-default env in scope, and ALIGN_GATEWAY_URL.
 *
 * vi.stubEnv(k, undefined) DELETES the variable (and vi.unstubAllEnvs restores it), which is the
 * state meant - an empty string is a different state.
 */
import { createRequire } from 'node:module';
import { vi } from 'vitest';

const require = createRequire(import.meta.url);
const vendors = require('ci-info/vendors.json') as Array<{ env: unknown }>;

const CI_GENERIC = ['CI', 'BUILD_ID', 'BUILD_NUMBER', 'CI_APP_ID', 'CI_BUILD_ID', 'CI_BUILD_NUMBER', 'CI_NAME', 'CONTINUOUS_INTEGRATION', 'RUN_ID'];

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

/** Every variable ci-info reads. Exported for telemetry-ci.test.ts's parity check. */
export const CI_ENV_KEYS: readonly string[] = [...new Set([...CI_GENERIC, ...vendors.flatMap((v) => namesIn(v.env))])];

export const TELEMETRY_ENV_KEYS: readonly string[] = [
  ...CI_ENV_KEYS,
  'DO_NOT_TRACK',
  'ALIGN_TELEMETRY',
  'ALIGN_WRAPPED',
  'ALIGN_TOKEN',
  'ALIGN_ENV',
  'ALIGN_TENANT_ID',
  // Where the anonymous events go. Exported in a shell it would point every send at a real host.
  'ALIGN_GATEWAY_URL',
];

/** Call first thing in a telemetry suite's top-level beforeEach; pair with vi.unstubAllEnvs(). */
export function clearTelemetryEnv(): void {
  for (const k of TELEMETRY_ENV_KEYS) vi.stubEnv(k, undefined);
}
