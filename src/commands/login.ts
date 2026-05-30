import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { loginInteractive } from '../lib/login-flow.js';

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
      const ok = await loginInteractive(env, envName, config);
      if (!ok) process.exit(1);
      p.outro(chalk.green('Ready. Run: align setup'));
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
