import type { Command } from 'commander';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { destinationLines } from '../lib/destination-summary.js';

const VALID_ENVS: EnvName[] = ['local', 'preview', 'prod'];

export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('Get or set the default environment (local, preview, prod)');

  env
    .command('set <env>')
    .description('Set the default environment for all commands')
    .action((name: string) => {
      if (!VALID_ENVS.includes(name as EnvName)) {
        console.error(chalk.red(`Invalid env "${name}". Must be one of: ${VALID_ENVS.join(', ')}`));
        process.exit(1);
      }
      createConfigStore().setDefaultEnv(name as EnvName);
      console.log(chalk.green(`Default env set to ${chalk.bold(name)}`));
      console.log(chalk.dim('All commands will now target this environment unless --env is passed.'));
    });

  env
    .command('list')
    .description('List the environments and every team destination joined with align join, with both hosts')
    .action(() => {
      const config = createConfigStore();
      for (const e of VALID_ENVS) console.log(`  ${e}`);
      for (const line of destinationLines(config)) console.log(line);
    });

  env
    .command('get')
    .description('Show the current default environment')
    .action(() => {
      const current = createConfigStore().getDefaultEnv();
      console.log(current);
    });
}
