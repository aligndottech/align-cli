import { resolveEnv } from '../lib/resolve-env.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { renderTable } from '../lib/table.js';

const SEVERITY_COLOR: Record<string, (s: string) => string> = {
  critical: chalk.bgRed.white,
  major: chalk.red,
  moderate: chalk.yellow,
  minor: chalk.dim,
  none: chalk.dim,
};

export function registerDriftCommand(program: Command): void {
  program
    .command('drift')
    .description('Show org-wide drift summary (decisions that may be out of date)')
    .option('--env <env>', 'Environment')
    .action(async (opts: { env?: EnvName }) => {
      const client = createGatewayClient(createConfigStore().getEnvironment(resolveEnv(opts.env)));
      const spinner = ora('Fetching drift summary...').start();
      try {
        const summary = await client.getDriftSummary();
        spinner.stop();
        if (!summary.length) {
          console.log(chalk.green('\nNo drift detected.\n'));
          return;
        }
        console.log(chalk.bold(`\nDrift Summary (${summary.length} decision${summary.length === 1 ? '' : 's'})\n`));
        renderTable(
          [
            { header: 'SEVERITY', width: 12 },
            { header: 'TITLE', width: 50 },
            { header: 'SUMMARY', width: 50 },
            { header: 'CHECKED', width: 20 },
          ],
          summary.map(d => {
            const color = SEVERITY_COLOR[d.drift_severity] ?? chalk.dim;
            return [
              color(d.drift_severity),
              d.title,
              d.drift_summary,
              new Date(d.checked_at).toLocaleDateString(),
            ];
          }),
        );
        console.log(chalk.dim('\n  Drift caught early. Teams get this as an automated CI gate with align check.'));
        console.log(chalk.dim('  https://align.tech/pricing\n'));
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
