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
import { type HookToolInput, readHookPayload } from '../lib/hook-payload.js';
import { markSurfaced, recentlySurfaced } from '../lib/advisory-dedup.js';

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
    .option('--advisory', 'Claude Code hook mode: always exit 0, emit conflicting decisions as additionalContext JSON. Detects Pre vs PostToolUse from the hook payload on stdin')
    .option('--block-on-critical', 'Advisory PreToolUse hook: deny an edit only on a CRITICAL conflict (default: never block, just surface context)')
    .option('--ci', 'CI mode: JSON output to stdout for GitHub Actions')
    .option('--resolve <resolution>', 'Record resolution for a conflict: <decision_id>:<type> where type is honored|overridden|context_changed')
    .action(async (opts: { env: EnvName; all: boolean; hook: boolean; advisory: boolean; blockOnCritical: boolean; ci: boolean; resolve?: string }) => {
      // Advisory mode is the deterministic auto-alignment path (ALI-121/ALI-122):
      // non-blocking, fail-open, machine-readable. It owns the whole flow, never
      // touching the human-facing spinner/console output below.
      if (opts.advisory) {
        await runAdvisory(opts.env, { blockOnCritical: opts.blockOnCritical });
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
      const envName: EnvName = resolveEnv(opts.env ?? rc.defaultEnv, { preferLocalEmbedded: true });

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

// Advisory (Claude Code hook) mode. Contract: ALWAYS exit 0 (never error out an
// edit), and on a conflict print the hook JSON so the conflicting decisions land in
// the agent's context. One entrypoint serves both hook events, detected from the
// payload Claude Code pipes on stdin:
//   - PreToolUse  -> check the PROPOSED edit before it is written (ALI-122)
//   - PostToolUse -> check the landed working-tree diff (ALI-121); also the path for
//     a manual `align check --advisory` run with no piped payload.
// Anything else (no repo, no diff, gateway down/slow, aligned) stays silent.
// Fail-open is the whole point - a hook that blocks or errors on every edit gets disabled.
async function runAdvisory(env: EnvName, opts: { blockOnCritical?: boolean } = {}): Promise<void> {
  try {
    const payload = await readHookPayload();
    const pre = payload?.hook_event_name === 'PreToolUse';

    let text: string;
    let context: string;
    if (pre) {
      text = proposedChangeText(payload?.tool_input);
      if (!text.trim()) process.exit(0);
      context = payload?.tool_input?.file_path ?? '';
    } else {
      if (!(await isGitRepo())) process.exit(0);
      text = await getHeadDiff();
      if (!text.trim()) process.exit(0);
      context = await getCurrentBranch().catch(() => '');
    }

    const envName: EnvName = resolveEnv(env, { preferLocalEmbedded: true });
    const config = createConfigStore();
    const client = createGatewayClient(config.getEnvironment(envName));

    // Race the check against a tight timeout so a slow gateway never stalls the edit.
    const result = await Promise.race<AlignmentResult | null>([
      client.checkAlignment(text, context),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ADVISORY_TIMEOUT_MS)),
    ]);

    if (result?.status === 'conflicting' && result.conflicts?.length) {
      // Drop conflicts the sibling hook already showed the agent moments ago.
      const cwd = process.cwd();
      const seen = recentlySurfaced(cwd);
      const fresh = result.conflicts.filter((c) => !(c.decision_id && seen.has(c.decision_id)));
      if (fresh.length) {
        markSurfaced(cwd, fresh.map((c) => c.decision_id).filter((id): id is string => Boolean(id)));
        const output = pre
          ? buildPreToolUseOutput(fresh, opts.blockOnCritical ?? false)
          : buildPostToolUseOutput(fresh);
        process.stdout.write(`${JSON.stringify(output)}\n`);
      }
    }
  } catch {
    // Fail open: swallow everything (gateway error, network, bad config).
  }
  process.exit(0);
}

type AdvisoryConflict = NonNullable<AlignmentResult['conflicts']>[number];

// The proposed change from a PreToolUse payload: Write sends the full content, Edit a
// new_string, MultiEdit a list of edits. We check the new text against the graph.
function proposedChangeText(input?: HookToolInput): string {
  if (!input) return '';
  if (typeof input.content === 'string') return input.content;
  if (Array.isArray(input.edits)) return input.edits.map((e) => e.new_string ?? '').join('\n');
  if (typeof input.new_string === 'string') return input.new_string;
  return '';
}

// Render conflicts as a concise, actionable nudge for the agent's context.
function conflictContext(conflicts: AdvisoryConflict[], closing: string): string {
  const lines = conflicts.map((c) => {
    const reason = c.reason && c.reason !== 'Conflicts with an existing team decision' ? ` - ${c.reason}` : '';
    const url = c.url ? ` (${c.url})` : '';
    return `- [${c.severity}] ${c.title}${reason}${url}`;
  });
  return [
    `Align decision graph: this change may conflict with ${conflicts.length} prior decision${conflicts.length > 1 ? 's' : ''}:`,
    ...lines,
    closing,
  ].join('\n');
}

function buildPostToolUseOutput(conflicts: AdvisoryConflict[]): {
  hookSpecificOutput: { hookEventName: 'PostToolUse'; additionalContext: string };
} {
  const additionalContext = conflictContext(conflicts, 'Reconcile with these decisions or confirm with the user before continuing.');
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } };
}

// PreToolUse fires before the edit is written. By default we only enrich the agent's
// context (no permissionDecision, so the normal permission flow is untouched). The
// opt-in `--block-on-critical` is the only path that denies, and only on a CRITICAL
// conflict - never block by default.
type PreToolUseOutput =
  | { hookSpecificOutput: { hookEventName: 'PreToolUse'; additionalContext: string } }
  | { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } };

function buildPreToolUseOutput(conflicts: AdvisoryConflict[], blockOnCritical: boolean): PreToolUseOutput {
  const summary = conflictContext(conflicts, 'Reconcile with these decisions or confirm with the user before writing this change.');
  if (blockOnCritical && conflicts.some((c) => c.severity === 'critical')) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: summary } };
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: summary } };
}
