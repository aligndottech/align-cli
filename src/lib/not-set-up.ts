import chalk from 'chalk';
import { createConfigStore, defaultGatewayUrlFor, type EnvironmentConfig, hasCredential } from './config.js';
import { resolveImportEnv } from './resolve-env.js';

/**
 * The one writer of "a built-in cloud env with no credential": the gateway client refuses
 * every request in this state, and `align connect` checks it before it reads anything. Returns
 * the message to show, or null when the env is usable (or is not a built-in cloud env at its
 * own URL, which stays the caller's business: a self-hosted URL with no token may be a real request).
 *
 * This is not `isAlignSetUp` (setup-state.ts), which answers "did this person ever choose
 * anything" for the plugin's advisory gate. Connect needs "will the env I resolved accept a
 * request", so it asks about the resolved env: a user set up for local-embedded, or logged in to
 * the env that resolved, passes; one holding only a token for a different env does not.
 */
export function notSetUpMessage(env: EnvironmentConfig, gatewayUrl: string = env.gatewayUrl): string | null {
  if (env.mode !== 'auth' || hasCredential(env)) return null;
  const name = (['prod', 'preview'] as const).find((n) => defaultGatewayUrlFor(n) === gatewayUrl);
  if (!name) return null;
  return name === 'prod'
    ? 'Align is not set up on this machine. Run `align` to set it up, or in a script run `align local start` or `align --repo-only --approve`.'
    : 'Align is not set up for preview on this machine. Run `align login --env preview`.';
}

/**
 * Before any read: a connect on a machine Align was never set up on stops with the one line that
 * says what to run, instead of fetching everything and failing each batch. Never sets anything up
 * (setup writes config and asks consent). An unresolvable env name is left to the path that already reports it.
 */
export function refuseUnlessSetUp(envFlag: string | undefined): void {
  let message: string | null;
  try {
    message = notSetUpMessage(createConfigStore().getEnvironment(resolveImportEnv(envFlag)));
  } catch {
    return;
  }
  if (!message) return;
  console.error(chalk.red(message));
  process.exit(1);
}
