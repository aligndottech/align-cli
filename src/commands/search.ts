import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveScopeOpts } from '../lib/repo-identity.js';

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Search the decision graph')
    .option('--env <env>', 'Environment')
    .option('--limit <n>', 'Max results', '10')
    .option('--repo <name>', 'Scope to one repo - short name, owner/repo, or full identity (local mode only)')
    .option('--all', 'Search every repo, not just the current one (local mode only)')
    // No --space here: smart-search has no space parameter on the gateway and the local graph
    // has no space concept, so the flag parsed and silently did nothing (ALI-505). Space
    // filtering lives where it works: `align decisions list --space <slug>`.
    .action(async (query: string, opts: { env: EnvName; limit: string; repo?: string; all?: boolean }) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const client = createGatewayClient(config.getEnvironment(envName));
      const scope = resolveScopeOpts({ repo: opts.repo, all: opts.all }, envName, (m) => console.log(chalk.yellow(m)));
      const spinner = ora(`Searching "${query}"...`).start();

      try {
        const results = await client.searchDecisions(query, parseInt(opts.limit, 10), scope);
        spinner.stop();

        if (!results.results.length) {
          console.log(chalk.dim('\nNo decisions found.\n'));
          return;
        }

        console.log(chalk.bold(`\n${results.count} result(s)  [${results.strategy}]\n`));
        // ALI-798: named for the same reason ask does - a reader should know what was
        // searched before wondering why a decision they expect is not in the list.
        if (results.scope) {
          console.log(chalk.dim(`Answering from ${results.scope} (--all searches every repo)\n`));
        }
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
