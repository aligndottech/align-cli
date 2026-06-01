import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { getCurrentBranch, getHeadDiff, getStagedDiff, isGitRepo } from '../lib/git.js';
import type { AlignmentResult } from '../lib/gateway-client.js';

// Advisory (PostToolUse hook) mode keeps a tight budget: a Write/Edit hook fires on
// every agent file change, so a slow gateway must never stall the edit. If the check
// hasn't answered within this window we fail open (exit 0, no output).
const ADVISORY_TIMEOUT_MS = 8000;

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Check current changes against the decision graph (exit 1 = conflict found)')
    .option('--env <env>', 'Environment')
    .option('--all', 'Check full HEAD diff, not just staged changes')
    .option('--hook', 'Pre-commit mode: silent on no context, only fail on critical conflicts')
    .option('--advisory', 'PostToolUse hook mode: always exit 0, emit conflicting decisions as additionalContext JSON for the agent')
    .option('--ci', 'CI mode: JSON output to stdout for GitHub Actions')
    .option('--resolve <resolution>', 'Record resolution for a conflict: <decision_id>:<type> where type is honored|overridden|context_changed')
    .action(async (opts: { env: EnvName; all: boolean; hook: boolean; advisory: boolean; ci: boolean; resolve?: string }) => {
      // Advisory mode is the deterministic auto-alignment path (ALI-121): non-blocking,
      // fail-open, machine-readable. It owns the whole flow, never touching the
      // human-facing spinner/console output below.
      if (opts.advisory) {
        await runAdvisory(opts.env);
        return;
      }

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
          console.log(chalk.green('\n  Aligned with decision graph.\n'));
          for (const d of result.relevant_decisions.slice(0, 3)) {
            console.log(`  ${chalk.green('+')} ${chalk.bold(d.title)}`);
            if (d.summary) {
              const snippet = d.summary.slice(0, 120).replace(/\n/g, ' ');
              console.log(chalk.dim(`    "${snippet}${d.summary.length > 120 ? '...' : ''}"`));
            }
            if (d.url) console.log(chalk.dim(`    ${d.url}`));
            console.log('');
          }
        } else if (result.status === 'conflicting') {
          const conflicts = result.conflicts ?? [];
          console.log(chalk.red(`\n  ${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''} with your decision graph:\n`));
          for (const c of conflicts) {
            const badge = c.severity === 'critical'
              ? chalk.bgRed.white(' CRITICAL ')
              : chalk.bgYellow.black(' WARNING  ');
            console.log(`  ${badge}  ${chalk.bold(c.title)}`);
            if (c.summary) {
              const snippet = c.summary.slice(0, 160).replace(/\n/g, ' ');
              console.log(chalk.dim(`           "${snippet}${c.summary.length > 160 ? '...' : ''}"`));
            }
            if (c.reason && c.reason !== 'Conflicts with an existing team decision') {
              console.log(`           ${chalk.yellow(c.reason)}`);
            }
            if (c.url) console.log(chalk.dim(`           ${c.url}`));
            console.log('');
          }
          if (opts.resolve) {
            const colonIdx = opts.resolve.indexOf(':');
            const decisionId = colonIdx > 0 ? opts.resolve.slice(0, colonIdx) : opts.resolve;
            const resolutionType = colonIdx > 0 ? opts.resolve.slice(colonIdx + 1) : 'honored';
            try {
              await client.resolveConflict({
                decision_id: decisionId,
                resolution_type: resolutionType as 'honored' | 'overridden' | 'context_changed',
                context: `align check on branch ${branch}`,
              });
              console.log(chalk.green(`\n  Resolution recorded for ${decisionId} (${resolutionType})\n`));
            } catch {
              console.log(chalk.dim('  (Could not record resolution - continuing)'));
            }
          }
          const hasCritical = conflicts.some(c => c.severity === 'critical');
          if (opts.hook && !hasCritical) process.exit(0);
          process.exit(1);
        } else {
          if (!opts.hook) console.log(chalk.dim('\n  No related decisions found in your graph.\n'));
        }
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        // Hook mode: never block commits if Align is unreachable
        if (!opts.hook) process.exit(1);
      }
    });
}

// Advisory (Claude Code PostToolUse) mode. Contract: ALWAYS exit 0 (never deny an
// edit), and on a conflict print the Claude Code hook JSON so the conflicting
// decisions land in the agent's context. Anything else (no repo, no diff, gateway
// down/slow, aligned) stays silent. Fail-open is the whole point - a hook that blocks
// or errors on every edit would get disabled.
async function runAdvisory(env: EnvName): Promise<void> {
  try {
    if (!(await isGitRepo())) process.exit(0);

    const diff = await getHeadDiff();
    if (!diff.trim()) process.exit(0);

    const envName: EnvName = resolveEnv(env);
    const config = createConfigStore();
    const client = createGatewayClient(config.getEnvironment(envName));
    const branch = await getCurrentBranch().catch(() => '');

    // Race the check against a tight timeout so a slow gateway never stalls the edit.
    const result = await Promise.race<AlignmentResult | null>([
      client.checkAlignment(diff, branch),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ADVISORY_TIMEOUT_MS)),
    ]);

    if (result?.status === 'conflicting' && result.conflicts?.length) {
      process.stdout.write(`${JSON.stringify(buildAdvisoryHookOutput(result.conflicts))}\n`);
    }
  } catch {
    // Fail open: swallow everything (gateway error, network, bad config).
  }
  process.exit(0);
}

type AdvisoryConflict = NonNullable<AlignmentResult['conflicts']>[number];

// Build the Claude Code PostToolUse hook payload. `additionalContext` is injected into
// the agent's context, so it reads as a direct, actionable nudge - not a status dump.
function buildAdvisoryHookOutput(conflicts: AdvisoryConflict[]): {
  hookSpecificOutput: { hookEventName: 'PostToolUse'; additionalContext: string };
} {
  const lines = conflicts.map((c) => {
    const reason = c.reason && c.reason !== 'Conflicts with an existing team decision' ? ` - ${c.reason}` : '';
    const url = c.url ? ` (${c.url})` : '';
    return `- [${c.severity}] ${c.title}${reason}${url}`;
  });
  const additionalContext = [
    `Align decision graph: this change may conflict with ${conflicts.length} prior decision${conflicts.length > 1 ? 's' : ''}:`,
    ...lines,
    'Reconcile with these decisions or confirm with the user before continuing.',
  ].join('\n');
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } };
}
