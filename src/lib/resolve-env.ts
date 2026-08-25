import { createConfigStore, type EnvName } from './config.js';

const VALID_ENVS: EnvName[] = ['local', 'preview', 'prod'];

export function resolveEnv(flagValue?: string, opts: { preferLocalEmbedded?: boolean } = {}): EnvName {
  if (flagValue && VALID_ENVS.includes(flagValue as EnvName)) {
    return flagValue as EnvName;
  }
  const fromEnvVar = process.env['ALIGN_ENV'];
  if (fromEnvVar && VALID_ENVS.includes(fromEnvVar as EnvName)) {
    return fromEnvVar as EnvName;
  }
  const config = createConfigStore();
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
 * Env resolution for `align import <tool>` (ALI-675).
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
