import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { createGatewayClient } from '../lib/gateway-client.js';

interface DecisionRow {
  id: string;
  title: string;
  summary: string;
  platform: string;
  status: string;
  created_at?: string;
  similarity?: number;
}

function formatBrief(decisions: DecisionRow[]): void {
  console.log(chalk.bold(`\n  Decision Brief  -  ${new Date().toLocaleDateString()}\n`));
  console.log(chalk.dim(`  ${decisions.length} decision(s)\n`));

  for (const d of decisions) {
    const statusColor = d.status === 'active' ? chalk.green : d.status === 'superseded' ? chalk.dim : chalk.yellow;
    console.log(`  ${chalk.bold(d.title)}  ${statusColor(d.status ?? 'unknown')}`);
    if (d.summary) {
      const snippet = d.summary.slice(0, 200).replace(/\n/g, ' ');
      console.log(chalk.dim(`  ${snippet}${d.summary.length > 200 ? '...' : ''}`));
    }
    const parts: string[] = [];
    if (d.platform) parts.push(d.platform);
    if (d.created_at) parts.push(new Date(d.created_at).toLocaleDateString());
    if (parts.length > 0) console.log(chalk.dim(`  ${parts.join('  |  ')}`));
    console.log('');
  }
}

export function registerExportCommand(program: Command): void {
  program
    .command('export [topic]')
    .description('Export decisions as a structured brief. Optionally filter by topic.')
    .option('--env <env>', 'Environment')
    .option('--format <fmt>', 'Output format: brief or json', 'brief')
    .option('--limit <n>', 'Max decisions to include', '50')
    .action(async (topic: string | undefined, opts: { env?: EnvName; format: string; limit: string }) => {
      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(resolveEnv(opts.env)));
      const limit = Math.max(1, parseInt(opts.limit, 10) || 50);
      const spinner = ora(topic ? `Searching for "${topic}"...` : 'Fetching decisions...').start();

      try {
        let decisions: DecisionRow[];

        if (topic) {
          const result = await client.searchDecisions(topic, limit);
          decisions = result.results.map(r => ({
            id: r.id,
            title: r.title,
            summary: r.summary,
            platform: (r as Record<string, unknown>)['platform'] as string ?? 'unknown',
            status: r.status,
            similarity: r.similarity,
          }));
        } else {
          const raw = await client.listDecisions({ limit });
          decisions = (Array.isArray(raw) ? raw : []) as DecisionRow[];
        }

        spinner.stop();

        if (decisions.length === 0) {
          console.log(chalk.dim('\n  No decisions found in your graph.\n'));
          return;
        }

        if (opts.format === 'json') {
          process.stdout.write(JSON.stringify({
            decisions,
            count: decisions.length,
            exported_at: new Date().toISOString(),
          }, null, 2));
          return;
        }

        formatBrief(decisions);
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
