import * as p from '@clack/prompts';
import chalk from 'chalk';
import open from 'open';
import { createGatewayClient } from './gateway-client.js';
import { CLI_CALLBACK_PORTS, waitForCallback } from './cli-oauth.js';
import type { createConfigStore, EnvironmentConfig, EnvName } from './config.js';

type ConfigStore = ReturnType<typeof createConfigStore>;

// Browser-based CLI login. Starts a local callback server, opens the branded
// login page, exchanges the returned token, verifies it, and persists the
// token + tenant id. Returns true on success. Shared by `align login` and the
// inline login on the cloud `align setup` path.
export async function loginInteractive(
  env: EnvironmentConfig,
  envName: EnvName,
  config: ConfigStore,
): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start('Opening browser for login...');

  let loginUrl = '';
  const callbackPromise = waitForCallback({
    ports: CLI_CALLBACK_PORTS,
    timeoutMs: 120_000,
    onBound: async (port, nonce) => {
      try {
        const res = await fetch(`${env.gatewayUrl}/auth/cli-init?port=${port}&nonce=${nonce}`);
        if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
        const body = await res.json() as { url: string };
        loginUrl = body.url;
        await open(loginUrl).catch(() => {});
        spinner.stop(`Browser opened. If nothing happened, visit:\n  ${chalk.bold(loginUrl)}`);
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
    p.log.error(`Login failed: ${(e as Error).message}`);
    return false;
  }

  const token = result.data['token'] as string | undefined;
  if (!token) {
    p.log.error('No token received. Try again or use: align login --token <token>');
    return false;
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
  } catch {
    verifySpinner.stop('Token saved (gateway unreachable for verification)');
    config.setAuthToken(envName, token);
    p.log.warn('Check the gateway is reachable with: align dev status');
    return true;
  }
}
