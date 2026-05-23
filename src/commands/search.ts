import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Search the decision graph')
    .option('--env <env>', 'Environment')
    .option('--limit <n>', 'Max results', '10')
    .option('--space <slug>', 'Filter by space')
    .action(async (query: string, opts: { env: EnvName; limit: string; space?: string }) => {
      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(resolveEnv(opts.env)));
      const spinner = ora(`Searching "${query}"...`).start();

      try {
        const results = await client.searchDecisions(query, parseInt(opts.limit, 10));
        spinner.stop();

        if (!results.results.length) {
          console.log(chalk.dim('\nNo decisions found.\n'));
          return;
        }

        console.log(chalk.bold(`\n${results.count} result(s)  [${results.strategy}]\n`));
        console.log(chalk.dim(`${'TITLE'.padEnd(52) + 'STATUS'.padEnd(12)  }SCORE`));
        console.log(chalk.dim('-'.repeat(72)));

        for (const d of results.results) {
          const title = d.title.length > 50 ? `${d.title.slice(0, 47)  }...` : d.title;
          const status = d.status === 'active' ? chalk.green(d.status) : chalk.dim(d.status);
          const score = d.similarity ? chalk.dim(d.similarity.toFixed(2)) : chalk.dim('n/a');
          console.log(`${title.padEnd(52)}${status.padEnd(22)}${score}`);
          console.log(chalk.dim(`  ${d.id}`));
        }
        console.log('');
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
