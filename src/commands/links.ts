import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { renderTable } from '../lib/table.js';

const RELATION_COLORS: Record<string, (s: string) => string> = {
  conflicts_with: chalk.red,
  contradicts: chalk.red,
  supersedes: chalk.yellow,
  supports: chalk.green,
  duplicates: chalk.dim,
};

export function registerLinksCommand(program: Command): void {
  const links = program
    .command('links')
    .description('Browse decision relationships and conflicts');

  links
    .command('list')
    .description('List decision links')
    .option('--env <env>', 'Environment')
    .option('--relation <type>', 'Filter by relation type (conflicts_with, supersedes, supports, etc.)')
    .option('--decision <id>', 'Filter by decision ID')
    .action(async (opts: { env?: EnvName; relation?: string; decision?: string }) => {
      const client = createGatewayClient(createConfigStore().getEnvironment(resolveEnv(opts.env)));
      const spinner = ora('Fetching links...').start();
      try {
        const items = await client.listDecisionLinks({
          relation: opts.relation,
          decision_id: opts.decision,
        });
        spinner.stop();
        if (!items.length) { console.log(chalk.dim('\nNo links found.\n')); return; }
        console.log(chalk.bold('\nDecision Links\n'));
        renderTable(
          [
            { header: 'FROM', width: 44 },
            { header: 'RELATION', width: 20 },
            { header: 'TO', width: 44 },
            { header: 'CONF', width: 6 },
          ],
          items.map(l => {
            const color = RELATION_COLORS[l.relation] ?? chalk.dim;
            return [
              l.from_decision.title,
              color(l.relation),
              l.to_decision.title,
              l.confidence.toFixed(1),
            ];
          }),
        );
        if (items.length >= 5) {
          console.log(chalk.dim('\n  Teams get this as a shared graph with CI drift detection.'));
          console.log(chalk.dim('  https://align.tech/pricing\n'));
        }
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
