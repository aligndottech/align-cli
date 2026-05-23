import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { getCurrentBranch, getHeadDiff, getStagedDiff, isGitRepo } from '../lib/git.js';

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Check current changes against the decision graph (exit 1 = conflict found)')
    .option('--env <env>', 'Environment')
    .option('--all', 'Check full HEAD diff, not just staged changes')
    .option('--hook', 'Pre-commit mode: silent on no context, only fail on critical conflicts')
    .option('--ci', 'CI mode: JSON output to stdout for GitHub Actions')
    .action(async (opts: { env: EnvName; all: boolean; hook: boolean; ci: boolean }) => {
      if (!await isGitRepo()) {
        if (!opts.ci) console.error(chalk.red('Not in a git repository'));
        process.exit(1);
      }

      const rcPath = join(process.cwd(), '.alignrc');
      const rc = existsSync(rcPath)
        ? (JSON.parse(readFileSync(rcPath, 'utf-8')) as { defaultEnv?: EnvName })
        : {};
      const envName: EnvName = resolveEnv(opts.env ?? rc.defaultEnv);

      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(envName));

      let diff = await getStagedDiff();
      if (!diff.trim() || opts.all) diff = await getHeadDiff();

      if (!diff.trim()) {
        if (!opts.hook && !opts.ci) console.log(chalk.dim('No changes to check.'));
        process.exit(0);
      }

      const branch = await getCurrentBranch().catch(() => '');

      if (opts.ci) {
        try {
          const result = await client.checkAlignment(diff, branch);
          process.stdout.write(`${JSON.stringify(result)  }\n`);
          process.exit(result.status === 'conflicting' ? 1 : 0);
        } catch (err) {
          process.stdout.write(`${JSON.stringify({ status: 'error', message: (err as Error).message })  }\n`);
          process.exit(0);
        }
      }

      const spinner = ora('Checking alignment...').start();
      try {
        const result = await client.checkAlignment(diff, branch);
        spinner.stop();

        if (result.status === 'aligned') {
          console.log(chalk.green('\nAligned with decision graph.\n'));
          for (const d of result.relevant_decisions.slice(0, 3)) {
            console.log(chalk.dim(`  - ${d.title} (${d.id})`));
          }
          if (result.relevant_decisions.length) console.log('');
        } else if (result.status === 'conflicting') {
          console.log(chalk.red('\nConflicts with decision graph:\n'));
          for (const c of result.conflicts ?? []) {
            const icon = c.severity === 'critical'
              ? chalk.bgRed.white(' CRITICAL ')
              : chalk.yellow(' WARNING ');
            console.log(`  ${icon} ${c.title}`);
            console.log(chalk.dim(`         ${c.reason}`));
            if (c.suggested_resolution) {
              console.log(chalk.dim(`         Suggestion: ${c.suggested_resolution}`));
            }
            console.log('');
          }
          const hasCritical = result.conflicts?.some(c => c.severity === 'critical');
          // Hook mode only blocks on critical conflicts to avoid false positives
          if (opts.hook && !hasCritical) process.exit(0);
          process.exit(1);
        } else {
          if (!opts.hook) console.log(chalk.dim('\nNo related decisions found.\n'));
        }
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        // Hook mode: never block commits if Align is unreachable
        if (!opts.hook) process.exit(1);
      }
    });
}
