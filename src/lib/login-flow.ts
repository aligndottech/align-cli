import * as p from '@clack/prompts';
import chalk from 'chalk';
import { assertTransport } from './destination-trust.js';
import { type VerifiedIdentity, verifyToken } from './join-flow.js';
import { tryOpenUrl } from './open-url.js';
import { visible } from './share/visible.js';
import { createGatewayClient, GatewayError } from './gateway-client.js';
import { CLI_CALLBACK_PORTS, waitForCallback } from './cli-oauth.js';
import type { createConfigStore, EnvironmentConfig, EnvName } from './config.js';

type ConfigStore = ReturnType<typeof createConfigStore>;

// Browser-based CLI login. Starts a local callback server, opens the branded
// login page, exchanges the returned token, verifies it, and persists the
// token + tenant id. Returns true on success. Shared by `align login` and the
// inline login on the cloud `align setup` path.
/**
 * The address /auth/cli-init hands back is opened in a browser, so it is checked first: http(s) only, and for a team destination its
 * origin must be the saved gateway's or web app's (a joined gateway is whatever was joined, so its word is not enough). A string
 * starting with '!' is the reason it was refused.
 */
export function checkLoginUrl(raw: unknown, env: EnvironmentConfig): string {
  if (typeof raw !== 'string' || raw === '') return '!the gateway sent no login address';
  let u: URL;
  try { u = new URL(raw); } catch { return '!the gateway sent something that is not a web address'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `!it is not a web address (${visible(u.protocol)})`;
  if (env.kind === 'team') {
    let origin: string;
    try { origin = assertTransport(u.origin); } catch (e) { return `!${visible((e as Error).message)}`; }
    const own = [env.gatewayUrl, env.appUrl].filter((x): x is string => typeof x === 'string').map((x) => x.replace(/\/+$/, ''));
    if (!own.includes(origin)) return `!${visible(u.host)} is not this destination's gateway or web app`;
  }
  return raw;
}

/**
 * `align login --env <team> --token X`: the no-browser renewal. A person at a terminal only, never inside an agent, and the token is
 * kept only once the destination's gateway says whose it is; the tenant saved is THAT one, never the previous token's.
 */
export async function saveTeamToken(
  env: EnvironmentConfig, envName: EnvName, token: string, config: ConfigStore, ctx: { wrapped: boolean; tty: boolean },
): Promise<VerifiedIdentity | string> {
  if (ctx.wrapped) return 'A token for a team destination has to be saved by you, in your own terminal, not from inside an agent. Nothing was saved.';
  if (!ctx.tty) return 'Saving a token for a team destination needs a terminal. Nothing was saved.';
  const who = await verifyToken(env.gatewayUrl, token);
  if (typeof who === 'string') return `${new URL(env.gatewayUrl).host} ${who}`;
  config.setAuthToken(envName, token);
  config.setTenantId(envName, who.tenantId);
  return who;
}

export async function loginInteractive(
  env: EnvironmentConfig,
  envName: EnvName,
  config: ConfigStore,
): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start('Opening browser for login...');

  let loginUrl = '';
  const stop = new AbortController();
  let refused = '';
  const callbackPromise = waitForCallback({
    ports: CLI_CALLBACK_PORTS,
    timeoutMs: 120_000,
    signal: stop.signal,
    onBound: async (port, nonce) => {
      try {
        const res = await fetch(`${env.gatewayUrl}/auth/cli-init?port=${port}&nonce=${nonce}`);
        if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
        const body = await res.json() as { url: unknown };
        const checked = checkLoginUrl(body.url, env);
        if (typeof checked !== 'string' || checked.startsWith('!')) {
          refused = typeof checked === 'string' ? checked.slice(1) : 'the gateway sent no login address';
          spinner.stop(`Not opening that address: ${refused}`);
          stop.abort();
          return;
        }
        loginUrl = checked;
        const opened = await tryOpenUrl(loginUrl);
        // The message follows the boolean: claiming "Browser opened" over a detected
        // failure is the same lie the paste path told in 0.28.0.
        spinner.stop(
          opened
            ? `Browser opened. If nothing happened, visit:\n  ${chalk.bold(visible(loginUrl))}`
            : `Could not open a browser here. Log in at:\n  ${chalk.bold(visible(loginUrl))}`,
        );
        p.log.info('Waiting for you to log in (2 min timeout)...');
      } catch (e) {
        spinner.stop(`Could not open browser: ${(e as Error).message}`);
      }
    },
  });

  let result: { data: Record<string, unknown>; port: number };
  try {
    result = await callbackPromise;
  } catch (e) {
    p.log.error(refused ? `Login stopped: ${refused}. Nothing was saved.` : `Login failed: ${(e as Error).message}`);
    return false;
  }

  const token = result.data['token'] as string | undefined;
  if (!token) {
    p.log.error('No token received. Try again or use: align login --token <token>');
    return false;
  }

  // A team destination is renewed the way it was joined: the token is only kept once the gateway has answered who it belongs to,
  // in the shape an Align gateway uses. "Unreachable" is not "verified" here, unlike the builtins below (join review F10).
  if (env.kind === 'team') {
    const spin = p.spinner();
    spin.start('Verifying token...');
    const who = await verifyToken(env.gatewayUrl, token);
    if (typeof who === 'string') {
      spin.stop('Login failed: the new token could not be verified.');
      p.log.error(`${new URL(env.gatewayUrl).host} ${who}`);
      return false;
    }
    config.setAuthToken(envName, token);
    config.setTenantId(envName, who.tenantId);
    spin.stop(`Logged in as ${visible(who.email)} (${visible(who.tenantName)}) [${envName}]`);
    return true;
  }

  const verifySpinner = p.spinner();
  verifySpinner.start('Verifying token...');
  try {
    const client = createGatewayClient({ ...env, authToken: token });
    const me = await client.whoami();
    config.setAuthToken(envName, token);
    if (me.tenant?.id) config.setTenantId(envName, me.tenant.id);
    verifySpinner.stop(`Logged in as ${me.user.email} (${me.tenant.name}) [${envName}]`);
    return true;
  } catch (err) {
    // A 401/403 means the gateway REJECTED the token - persisting it would leave the
    // user "logged in" but failing on every later command. Only fail OPEN (save +
    // warn) for a genuinely unreachable gateway (network error / status 0), where we
    // can't verify now but the token is probably fine.
    const status = err instanceof GatewayError ? err.statusCode : 0;
    if (status === 401 || status === 403) {
      verifySpinner.stop('Login failed: the gateway rejected that token.');
      p.log.error('That token was not accepted. Run `align login` again.');
      return false;
    }
    verifySpinner.stop('Token saved (gateway unreachable for verification)');
    config.setAuthToken(envName, token);
    p.log.warn('Check the gateway is reachable with: align dev status');
    return true;
  }
}
