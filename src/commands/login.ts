import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import open from 'open';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveAppUrl } from '../lib/env-resolver.js';

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
      const appUrl = resolveAppUrl(env);
      const loginUrl = `${appUrl}/settings?tab=api-tokens`;

      p.note(
        `To authenticate:\n1. Visit ${chalk.bold(loginUrl)}\n2. Click "Generate token", copy the token\n3. Paste it below`,
        'Get your token',
      );

      await open(loginUrl).catch(() => {
        // Browser open is best-effort
      });

      const token = await p.password({
        message: 'Paste your API token:',
        validate: (v) => v.length < 10 ? 'Token too short' : undefined,
      });
      if (p.isCancel(token)) { p.cancel('Cancelled.'); process.exit(0); }

      const spinner = p.spinner();
      spinner.start('Verifying token...');
      try {
        const client = createGatewayClient({ ...env, authToken: token as string });
        const me = await client.whoami();
        config.setAuthToken(envName, token as string);
        if (me.tenant?.id) config.setTenantId(envName, me.tenant.id);
        spinner.stop(`Logged in as ${me.user.email} (${me.tenant.name}) [${envName}]`);
        p.outro(chalk.green('Ready. Run: align whoami'));
      } catch {
        spinner.stop('Could not verify token - token saved anyway');
        p.log.warn('Check the gateway is reachable with: align dev status');
        config.setAuthToken(envName, token as string);
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
