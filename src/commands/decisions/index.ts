import { resolveEnv } from '../../lib/resolve-env.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { renderTable } from '../../lib/table.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';

export function registerDecisionsCommand(program: Command): void {
  const decisions = program
    .command('decisions')
    .description('Browse and inspect decisions in the graph');

  decisions
    .command('list')
    .description('List decisions')
    .option('--env <env>', 'Environment')
    .option('--platform <p>', 'Filter by platform (slack, jira, github, etc.)')
    .option('--status <s>', 'Filter by status (active, superseded, archived)')
    .option('--space <slug>', 'Filter by space slug')
    .option('--limit <n>', 'Max results', '20')
    .action(async (opts: {
      env: EnvName; platform?: string; status?: string; space?: string; limit: string;
    }) => {
      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(resolveEnv(opts.env)));
      const spinner = ora('Fetching decisions...').start();

      try {
        const params: Record<string, string | number | boolean> = { limit: parseInt(opts.limit, 10) };
        if (opts.platform) params['platform'] = opts.platform;
        if (opts.status) params['status'] = opts.status;
        if (opts.space) params['space'] = opts.space;

        const decisions = await client.listDecisions(params);
        spinner.stop();

        if (!decisions.length) {
          console.log(chalk.dim('\nNo decisions found.\n'));
          return;
        }

        console.log(chalk.bold(`\nDecisions (${opts.env})\n`));
        renderTable(
          [
            { header: 'ID', width: 38 },
            { header: 'TITLE', width: 50 },
            { header: 'PLATFORM', width: 14 },
            { header: 'STATUS', width: 12 },
          ],
          decisions.map(d => [d.id, d.title, d.platform, d.status ?? '']),
        );
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  decisions
    .command('show <id>')
    .description('Show full detail for a decision')
    .option('--env <env>', 'Environment')
    .action(async (id: string, opts: { env: EnvName }) => {
      const config = createConfigStore();
      const env = config.getEnvironment(resolveEnv(opts.env));
      const client = createGatewayClient(env);
      const spinner = ora(`Loading decision ${id}...`).start();

      try {
        const d = await client.getDecision(id);
        spinner.stop();

        console.log('');
        console.log(`  ${chalk.bold('ID:')}       ${d.id}`);
        console.log(`  ${chalk.bold('Title:')}    ${d.title}`);
        console.log(`  ${chalk.bold('Summary:')}  ${d.summary}`);
        console.log(`  ${chalk.bold('Platform:')} ${d.platform}`);
        if (d.ai?.risks?.length) {
          console.log(`\n  ${chalk.bold('Risks:')}`);
          for (const r of d.ai.risks) console.log(`    - ${r}`);
        }
        if (d.ai?.actions?.length) {
          console.log(`\n  ${chalk.bold('Actions:')}`);
          for (const a of d.ai.actions) console.log(`    - ${a.text}`);
        }
        if (d.spaces?.length) {
          console.log(`\n  ${chalk.bold('Spaces:')} ${(d.spaces as Array<{ name: string }>).map(s => s.name).join(', ')}`);
        }
        console.log('');
        console.log(chalk.dim(`View: ${resolveAppUrl(env)}/decisions/${d.id}`));
        console.log('');
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
