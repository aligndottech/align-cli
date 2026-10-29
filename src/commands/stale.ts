import type { Command } from 'commander';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { StaleError } from '../lib/stale-code.js';
import { runStale } from '../lib/stale-run.js';
import { renderReport } from '../lib/stale-render.js';

export function registerStaleCommand(program: Command): void {
  program
    .command('stale')
    .description('List the code still built on a decision that a later decision replaced')
    .option('--env <env>', 'Environment')
    .option('--include-ai', 'Also use supersedes links an AI suggested and no person confirmed')
    .option('--max-files <n>', 'Most files checked per replaced decision', '40')
    .option('--budget-seconds <n>', 'Stop checking after this many seconds', '90')
    .option('--json', 'Print the result as JSON')
    .action(async (opts: { env?: EnvName; includeAi?: boolean; maxFiles?: string; budgetSeconds?: string; json?: boolean }) => {
      try {
        const env = createConfigStore().getEnvironment(resolveEnv(opts.env));
        const client = env.mode === 'local-embedded' ? null : createGatewayClient(env);
        const { report, loadNotes, result } = await runStale(env, client, {
          cwd: process.cwd(),
          includeAi: opts.includeAi === true,
          maxFilesPerDecision: Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : undefined,
          budgetMs: Number(opts.budgetSeconds) > 0 ? Number(opts.budgetSeconds) * 1000 : undefined,
        });
        if (opts.json) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
        console.log(`\n${renderReport(report, loadNotes, opts.includeAi === true)}\n`);
      } catch (err) {
        const msg = (err as Error).message;
        if (opts.json) process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
        else console.error(chalk.red(err instanceof StaleError ? msg : `align stale failed: ${msg}`));
        process.exit(1);
      }
    });
}
