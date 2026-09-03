import { resolveEnv } from '../../lib/resolve-env.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { createGatewayClient } from '../../lib/gateway-client.js';
import { renderTable } from '../../lib/table.js';
import { resolveAppUrl } from '../../lib/env-resolver.js';
import { resolveScopeOpts } from '../../lib/repo-identity.js';
import { formatWhen } from '../../lib/format-date.js';
import { deciderLabel } from '../../lib/decider-kind.js';

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
    .option('--repo <name>', 'Scope to one repo - short name, owner/repo, or full identity (local mode only)')
    .option('--all', 'List every repo, not just the current one (local mode only)')
    .option('--limit <n>', 'Max results', '20')
    .option('--unratified', 'The human queue: agent-decided rows no human has ratified')
    .action(async (opts: {
      env: EnvName; platform?: string; status?: string; space?: string; repo?: string; all?: boolean; limit: string; unratified?: boolean;
    }) => {
      const config = createConfigStore();
      // Held, not re-derived: the header below printed `opts.env`, which is the FLAG. With no
      // flag that rendered "Decisions (undefined)" - hidden until now only because a bare call
      // 401'd before it got this far (ALI-772).
      const envName = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const client = createGatewayClient(config.getEnvironment(envName));
      const scope = resolveScopeOpts({ repo: opts.repo, all: opts.all }, envName, (m) => console.log(chalk.yellow(m)));
      const spinner = ora('Fetching decisions...').start();

      try {
        const params: Record<string, string | number | boolean> = { limit: parseInt(opts.limit, 10) };
        if (opts.platform) params['platform'] = opts.platform;
        if (opts.status) params['status'] = opts.status;
        if (opts.space) params['space'] = opts.space;
        // ALI-798: only local mode has a repo dimension - resolveScopeOpts already dropped
        // (and warned about) repo/all in any other mode, so `scope` is undefined there.
        if (scope?.repo !== undefined) params['repo'] = scope.repo;
        if (scope?.all) params['all'] = scope.all;
        if (opts.unratified) params['unratified'] = true;

        const decisions = await client.listDecisions(params);
        spinner.stop();

        if (!decisions.length) {
          console.log(chalk.dim('\nNo decisions found.\n'));
          return;
        }

        // ALI-831: names the queue so the header does not read like the normal listing.
        console.log(chalk.bold(`\n${opts.unratified ? 'Unratified agent decisions' : 'Decisions'} (${envName})\n`));
        renderTable(
          [
            { header: 'ID', width: 38 },
            // 40, not 50: with DECIDED the row is 118 columns, which still fits a 120-column
            // terminal; at 50 it was 128 and every row wrapped.
            { header: 'TITLE', width: 40 },
            { header: 'PLATFORM', width: 14 },
            { header: 'STATUS', width: 12 },
            // ALI-829: when it was DECIDED, from the source. Empty when the source did not
            // say - formatWhen returns '' for a missing or unparseable value, so a row with
            // no date never reads "Invalid Date" and never borrows the ingest minute.
            { header: 'DECIDED', width: 14 },
          ],
          decisions.map(d => [d.id, d.title, d.platform, d.status ?? '', formatWhen(d.decided_at)]),
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
      const envName = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const env = config.getEnvironment(envName);
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
        const decider = deciderLabel(d);
        if (decider) console.log(`  ${chalk.bold('Decider:')}  ${decider}`);
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
        // A local graph has no web UI, so this line pointed a local-only user at
        // http://localhost:5173/decisions/<id> - a dev server that is not running on their
        // machine and never will be. Printing a dead link is worse than printing nothing.
        if (envName !== 'local') {
          console.log(chalk.dim(`View: ${resolveAppUrl(env)}/decisions/${d.id}`));
          console.log('');
        }
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
