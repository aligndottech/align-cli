import { type BuiltinEnv, createConfigStore, type EnvName } from './config.js';

const VALID_ENVS: BuiltinEnv[] = ['local', 'preview', 'prod'];

/**
 * A name that is neither a builtin nor a saved team destination. Resolution used to fall back to
 * the stored default for any such name, so `--env prodd` quietly ran against prod and
 * `--env acme` against whatever the default was. A name the user typed on purpose now either
 * means what they said or stops (join plan S6).
 */
export class UnknownEnvError extends Error {
  constructor(value: string, destinations: string[]) {
    const shown = value.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
    const valid = [...VALID_ENVS, ...destinations].join(', ');
    super(`Unknown environment "${shown}". Valid environments: ${valid}.`);
    this.name = 'UnknownEnvError';
  }
}

type ConfigStore = ReturnType<typeof createConfigStore>;

/** A builtin or a saved team destination, or UnknownEnvError. The one place a typed name is accepted. */
export function acceptEnvName(name: string, config: Pick<ConfigStore, 'hasTeamDestination' | 'listTeamDestinationNames'>): EnvName {
  if ((VALID_ENVS as string[]).includes(name)) return name as EnvName;
  if (config.hasTeamDestination(name)) return name as EnvName;
  throw new UnknownEnvError(name, config.listTeamDestinationNames());
}

export function resolveEnv(flagValue?: string, opts: { preferLocalEmbedded?: boolean; config?: ConfigStore } = {}): EnvName {
  const config = opts.config ?? createConfigStore();
  if (flagValue) return acceptEnvName(flagValue, config);
  const fromEnvVar = process.env['ALIGN_ENV'];
  if (fromEnvVar) return acceptEnvName(fromEnvVar, config);
  const defaultEnv = config.getDefaultEnv();
  // A user who ran `align setup --local` has local-embedded configured but the
  // default env stays a cloud env (deliberate, so cloud-only commands are not
  // hijacked). For the read/query commands that local DOES serve (ask/search/
  // check), prefer the local graph when the cloud default is unauthenticated -
  // otherwise a no-account local user's first `align ask` silently 401s the cloud.
  // A logged-in user (cloud token present) is never redirected.
  if (opts.preferLocalEmbedded && defaultEnv !== 'local') {
    const local = config.getEnvironment('local');
    const cloud = config.getEnvironment(defaultEnv);
    if (local.mode === 'local-embedded' && !cloud.authToken && cloud.mode !== 'demo') {
      return 'local';
    }
  }
  return defaultEnv;
}

/**
 * Env resolution for `align connect <tool>`.
 *
 * Imports were left off the preferLocalEmbedded redirect on the premise that
 * they are cloud-only. They are not: the local-embedded client implements
 * ingestBatch (on-device embeddings, cross-item linking), and every fetcher
 * runs client-side - so a no-account user's `align import jira` was resolving
 * to an unauthenticated cloud default and 401ing, on the exact multi-tool
 * first run the product is pitched on. Setup's own retry hint sends users
 * here (setup.ts), which made the 401 a guided experience.
 *
 * Same guarantees as the read-command redirect, pinned in resolve-env.test.ts:
 * an explicit --env always wins, and a logged-in user is never hijacked.
 */
export function resolveImportEnv(flagValue?: string): EnvName {
  return resolveEnv(flagValue, { preferLocalEmbedded: true });
}
