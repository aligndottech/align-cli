import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { renderTable } from '../lib/table.js';

export function registerSpacesCommand(program: Command): void {
  const spaces = program
    .command('spaces')
    .description('Manage spaces (project scopes for organizing decisions)');

  spaces
    .command('list')
    .description('List all spaces')
    .option('--env <env>', 'Environment')
    .action(async (opts: { env?: EnvName }) => {
      const client = createGatewayClient(createConfigStore().getEnvironment(resolveEnv(opts.env)));
      const spinner = ora('Fetching spaces...').start();
      try {
        const list = await client.listSpaces();
        spinner.stop();
        if (!list.length) {
          console.log(chalk.dim('\nNo spaces yet. Create one at the web app.\n'));
          return;
        }
        console.log(chalk.bold('\nSpaces\n'));
        renderTable(
          [
            { header: 'SLUG', width: 24 },
            { header: 'NAME', width: 32 },
            { header: 'TYPE', width: 16 },
            { header: 'ID', width: 38 },
          ],
          list.map(s => [s.slug, s.name, s.space_type, s.id]),
        );
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
