import vendors from 'ci-info/vendors.json' with { type: 'json' };

/**
 * C6: whether this run is a CI job. Nothing is sent from CI, the notice is not shown there, and
 * the install is not marked recorded - a CI job is not a person installing Align.
 *
 * Answers from ci-info's own vendor table (`ci-info/vendors.json`), with ci-info's predicate
 * re-applied on every call. ci-info's `isCI` export is computed once, when the module loads, so
 * a test runner started with CI=true - every CI run - could never stub it back to false, and
 * every telemetry suite would invert there. telemetry-ci.test.ts asks the real ci-info, in a
 * child process, the same question for each case, so a drift between the two fails there.
 */
type EnvRule = string | { env: string; includes: string } | { any: string[] } | Record<string, string>;
interface Vendor { env: EnvRule | EnvRule[] }

/** ci-info's generic flags, in its own order: any one of them set means CI. */
const GENERIC = ['BUILD_ID', 'BUILD_NUMBER', 'CI', 'CI_APP_ID', 'CI_BUILD_ID', 'CI_BUILD_NUMBER', 'CI_NAME', 'CONTINUOUS_INTEGRATION', 'RUN_ID'];

function matches(rule: EnvRule, env: Record<string, string | undefined>): boolean {
  if (typeof rule === 'string') return Boolean(env[rule]);
  if ('env' in rule && typeof rule.env === 'string' && 'includes' in rule) {
    return Boolean(env[rule.env]?.includes(String(rule.includes)));
  }
  if ('any' in rule && Array.isArray(rule.any)) return rule.any.some((k) => Boolean(env[k]));
  return Object.entries(rule as Record<string, string>).every(([k, v]) => env[k] === v);
}

export function inCi(env: Record<string, string | undefined> = process.env): boolean {
  if (env['CI'] === 'false') return false;
  if (GENERIC.some((k) => Boolean(env[k]))) return true;
  return (vendors as Vendor[]).some((v) => (Array.isArray(v.env) ? v.env : [v.env]).every((r) => matches(r, env)));
}
