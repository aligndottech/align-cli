import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import open from 'open';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { CLI_CALLBACK_PORTS, waitForCallback } from '../lib/cli-oauth.js';

export function registerLoginCommands(program: Command): void {
  program
    .command('login')
    .description('Authenticate with Align')
    .option('--env <env>', 'Environment (local, preview, prod)')
    .option('--token <token>', 'Use a token directly (for CI / self-hosted)')
    .action(async (opts: { env?: EnvName; token?: string }) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);

      if (opts.token) {
        config.setAuthToken(envName, opts.token);
        p.log.success(`Token saved for ${envName}`);
        return;
      }

      p.intro(chalk.bgMagenta.white(' align login '));
      const spinner = p.spinner();
      spinner.start('Opening browser for login...');

      // Start local callback server; onBound fires as soon as the port is bound
      // so we can immediately fetch the browser URL and open it.
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
        process.exit(1);
      }

      const token = result.data['token'] as string | undefined;
      if (!token) {
        p.log.error('No token received. Try again or use: align login --token <token>');
        process.exit(1);
      }

      const verifySpinner = p.spinner();
      verifySpinner.start('Verifying token...');
      try {
        const client = createGatewayClient({ ...env, authToken: token });
        const me = await client.whoami();
        config.setAuthToken(envName, token);
        if (me.tenant?.id) config.setTenantId(envName, me.tenant.id);
        verifySpinner.stop(`Logged in as ${me.user.email} (${me.tenant.name}) [${envName}]`);
        p.outro(chalk.green('Ready. Run: align setup'));
      } catch {
        verifySpinner.stop('Token saved (gateway unreachable for verification)');
        config.setAuthToken(envName, token);
        p.log.warn('Check the gateway is reachable with: align dev status');
      }
    });

  program
    .command('logout')
    .description('Clear stored credentials')
    .option('--env <env>', 'Environment')
    .action((opts: { env?: EnvName }) => {
      const envName = resolveEnv(opts.env);
      createConfigStore().clear(envName);
      console.log(chalk.green(`Logged out of ${envName}`));
    });

  program
    .command('whoami')
    .description('Show current authenticated user and tenant')
    .option('--env <env>', 'Environment')
    .action(async (opts: { env?: EnvName }) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);
      if (!env.authToken && env.mode !== 'demo') {
        console.log(chalk.yellow(`Not logged in to ${envName}. Run: align login --env ${envName}`));
        process.exit(1);
      }
      try {
        const me = await createGatewayClient(env).whoami();
        console.log(`\n  Email:  ${me.user.email}`);
        console.log(`  Role:   ${me.user.role}`);
        console.log(`  Tenant: ${me.tenant.name} (${me.tenant.id})`);
        console.log(`  Env:    ${envName}`);
        console.log('');
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
