import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { getBaseDiff, getCurrentBranch, getHeadDiff, getStagedDiff, isGitRepo } from '../lib/git.js';
import type { AlignmentResult } from '../lib/gateway-client.js';
import { type HookToolInput, readHookPayload } from '../lib/hook-payload.js';
import { markSurfaced, recentlySurfaced } from '../lib/advisory-dedup.js';

// The hook budget on EVERY host is <=10s (Claude Code HOOK_TIMEOUT_SECONDS, and the 10s
// execFile timeout in the pi and OpenCode shims). Adjudication measured ~11s whenever
// retrieval returns anything, so the old synchronous check timed out on exactly the edits it
// existed for and printed nothing. Retrieval alone measured 0.4-2.4s, which fits.
const RETRIEVAL_TIMEOUT_MS = 2500;

// Exit codes. `unknown` gets its own code (ALI-414) rather than reusing 1: "we found
// a conflict" and "we could not look" call for different responses, and a caller that
// only tests for non-zero still treats both as a failure.
const EXIT_CONFLICT = 1;
const EXIT_UNKNOWN = 2;

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Check current changes against the decision graph (exit 1 = conflict found)')
    .option('--env <env>', 'Environment')
    .option('--all', 'Check full HEAD diff, not just staged changes')
    .option('--hook', 'Pre-commit mode: silent on no context, only fail on critical conflicts')
    .option('--advisory', 'Agent hook mode: always exit 0, emit related (unadjudicated) decisions in the host agent\'s hook output shape. Detects pre vs post from the hook payload on stdin')
    .option('--format <format>', 'Advisory output shape for the host agent: claude (default), gemini, pi, opencode, or text', 'claude')
    .option('--block-on-critical', 'Advisory PreToolUse hook: deny an edit only on a CRITICAL conflict (default: never block, just surface context)')
    .option('--ci', 'CI mode: JSON output to stdout for GitHub Actions')
    .option('--title <text>', 'The decision being proposed, in words (e.g. the PR title). Without it the gateway adjudicates on the first 200 characters of the diff, which is a file header and a few + lines')
    .option('--base <ref>', 'Diff against the merge base with <ref> (e.g. origin/main). Required in CI: a clean checkout has no staged or unstaged changes, so without it there is nothing to check and the command passes without looking')
    .option('--resolve <resolution>', 'Record resolution for a conflict: <decision_id>:<type> where type is honored|overridden|context_changed')
    .action(async (opts: { env: EnvName; all: boolean; hook: boolean; advisory: boolean; blockOnCritical: boolean; format?: AdvisoryFormat; ci: boolean; base?: string; title?: string; resolve?: string }) => {
      // Advisory mode is the deterministic auto-alignment path (ALI-121/ALI-122):
      // non-blocking, fail-open, machine-readable. It owns the whole flow, never
      // touching the human-facing spinner/console output below.
      if (opts.advisory) {
        await runAdvisory(opts.env, { blockOnCritical: opts.blockOnCritical, format: opts.format });
        return;
      }

      if (!await isGitRepo()) {
        if (!opts.ci) console.error(chalk.red('Not in a git repository'));
        process.exit(1);
      }

      // .alignrc was read here for { defaultEnv } and nothing anywhere wrote or documented it -
      // a third env-selection mechanism next to ALIGN_ENV and `align env set`, applying to this
      // one command, with an unguarded JSON.parse. Dropped (ALI-505).
      const envName: EnvName = resolveEnv(opts.env, { preferLocalEmbedded: true });

      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(envName));

      let diff: string;
      if (opts.base) {
        // An unresolvable base (a typo, a shallow clone with no history, a deleted branch)
        // must NOT fall through to the empty-diff path below: "I could not look" and "there
        // was nothing to look at" are the same green from the outside, which is the exact
        // silent pass this option exists to remove (ALI-414).
        try {
          diff = await getBaseDiff(opts.base);
        } catch (err) {
          const message = `Could not diff against '${opts.base}': ${(err as Error).message}`;
          if (opts.ci) {
            process.stdout.write(`${JSON.stringify({ status: 'unknown', reason: 'bad_base_ref', message })}\n`);
          } else {
            console.error(chalk.red(message));
          }
          process.exit(EXIT_UNKNOWN);
        }
      } else {
        diff = await getStagedDiff();
        if (!diff.trim() || opts.all) diff = await getHeadDiff();
      }

      if (!diff.trim()) {
        if (!opts.hook && !opts.ci) console.log(chalk.dim('No changes to check.'));
        process.exit(0);
      }

      const branch = await getCurrentBranch().catch(() => '');

      if (opts.ci) {
        try {
          const result = await client.checkAlignment(diff, branch, { title: opts.title });
          process.stdout.write(`${JSON.stringify(result)  }\n`);
          if (result.status === 'conflicting') process.exit(EXIT_CONFLICT);
          // CI is where a silent green costs the most: a check that could not run
          // must not be indistinguishable from a check that found nothing (ALI-414).
          process.exit(result.status === 'unknown' ? EXIT_UNKNOWN : 0);
        } catch (err) {
          process.stdout.write(`${JSON.stringify({ status: 'error', message: (err as Error).message })  }\n`);
          process.exit(0);
        }
      }

      const spinner = ora('Checking alignment...').start();
      try {
        const result = await client.checkAlignment(diff, branch, { title: opts.title });
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
          process.exit(EXIT_CONFLICT);
        } else if (result.status === 'unknown') {
          // ALI-414: the check did not run. Never a green header, and never the
          // "no related decisions" line - the decisions may well be there, we just
          // could not classify them. Show them so the human can review by hand.
          console.log(chalk.yellow('\n  Could not check this change against your decision graph.\n'));
          console.log(chalk.dim(`  ${result.message}\n`));
          for (const d of result.relevant_decisions.slice(0, 3)) {
            console.log(`  ${chalk.yellow('?')} ${chalk.bold(d.title)}`);
            if (d.summary) {
              const snippet = d.summary.slice(0, 120).replace(/\n/g, ' ');
              console.log(chalk.dim(`    "${snippet}${d.summary.length > 120 ? '...' : ''}"`));
            }
            if (d.url) console.log(chalk.dim(`    ${d.url}`));
            console.log('');
          }
          // Pre-commit hook mode stays non-blocking (its contract is "only fail on
          // critical conflicts"): a user with no LLM key would otherwise have every
          // commit rejected and would just uninstall the hook. It is no longer
          // SILENT, though - the lines above still print.
          if (opts.hook) process.exit(0);
          process.exit(EXIT_UNKNOWN);
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
// edit), and when retrieval finds related decisions print the hook JSON so they land
// in the agent's context. One entrypoint serves both hook events, detected from the
// payload Claude Code pipes on stdin:
//   - PreToolUse  -> check the PROPOSED edit before it is written (ALI-122)
//   - PostToolUse -> check the landed working-tree diff (ALI-121); also the path for
//     a manual `align check --advisory` run with no piped payload.
// Anything else (no repo, no diff, gateway down/slow, aligned) stays silent.
// Fail-open is the whole point - a hook that blocks or errors on every edit gets disabled.
async function runAdvisory(env: EnvName, opts: { blockOnCritical?: boolean; format?: AdvisoryFormat } = {}): Promise<void> {
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

    const format = opts.format ?? 'claude';
    const renderOpts = { pre, format, blockOnCritical: opts.blockOnCritical ?? false };
    // A host with no channel for this event (Gemini's BeforeTool) gets nothing.
    const emit = (output: unknown | null): void => {
      if (output !== null) {
        process.stdout.write(`${format === 'text' ? output : JSON.stringify(output)}\n`);
      }
    };

    // RETRIEVAL ONLY. Adjudication is ~11s and does not fit any host's hook budget, so it
    // moves to a follow-up rather than timing out here and printing nothing. Nothing is lost:
    // the LLM runs whenever retrieval returns anything, so no tenant was getting a verdict
    // through the hook - the fast path measured 0.8s only because it was `no-context`.
    let found: RelatedDecision[] | null = null;
    try {
      const result = await Promise.race([
        // The SAME embedding retrieval `align check` uses, minus the adjudication. Plain
        // `searchDecisions` is keyword-based and returns nothing for a sentence of edit
        // content, which is why this path needed gateway #1415 rather than the search API.
        client.checkAlignment(text, context, { depth: 'related' }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), RETRIEVAL_TIMEOUT_MS)),
      ]);
      found = result === null ? null : (result.relevant_decisions ?? []);
    } catch {
      found = null;
    }

    if (found === null) {
      // Never silent on a non-answer (ALI-414 / ALI-348).
      emit(buildUnknownOutput(renderOpts));
      process.exit(0);
    }

    // Genuinely nothing related: a real answer, so staying quiet is honest here.
    if (!found.length) process.exit(0);

    // Drop decisions the sibling hook already showed the agent moments ago.
    const cwd = process.cwd();
    const seen = recentlySurfaced(cwd);
    const fresh = found.filter((d) => !seen.has(d.id));
    if (fresh.length) {
      markSurfaced(cwd, fresh.map((d) => d.id));
      emit(buildRelatedOutput(fresh, renderOpts));
    }
  } catch {
    // Fail open: swallow everything (gateway error, network, bad config).
  }
  process.exit(0);
}

type AdvisoryConflict = NonNullable<AlignmentResult['conflicts']>[number];

type RelatedDecision = { id: string; title: string; summary?: string };

// Retrieval finds decisions on the same SUBJECT. It does not encode opposition - ALI-410
// measured the agreeing pair at cosine 0.38 against the contradicting pair at 0.31 - so this
// wording must never assert a conflict. Saying "related" is the honest claim and the useful one.
export function buildRelatedOutput(decisions: RelatedDecision[], opts: AdvisoryRenderOpts): unknown | null {
  const lines = decisions.map((d) => `- ${d.title}`);
  const summary = [
    `Align decision graph: ${decisions.length} prior decision${decisions.length > 1 ? 's relate' : ' relates'} to this change:`,
    ...lines,
    'These are related by content search and have NOT been adjudicated. Check whether any of them opposes this change before continuing.',
  ].join('\n');
  return renderForHost(summary, opts, false);
}

// ALI-414 / ALI-348: a check that could not run is not a pass. Silence here would be
// indistinguishable from "nothing found", which is the exact fail-open both tickets closed.
export function buildUnknownOutput(opts: AdvisoryRenderOpts): unknown | null {
  const summary = [
    'Align could not check this change against the decision graph (retrieval failed or timed out).',
    'Treat it as UNVERIFIED rather than approved - run `align check` manually if it matters.',
  ].join('\n');
  return renderForHost(summary, opts, false);
}

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

// The host agents whose hook output contract we can speak. `text` is the universal
// fallback for a host that just runs a command and shows whatever it printed.
export type AdvisoryFormat = 'claude' | 'gemini' | 'pi' | 'opencode' | 'text';

export interface AdvisoryRenderOpts {
  pre: boolean;
  format: AdvisoryFormat;
  blockOnCritical: boolean;
}

// NO RUNTIME CALLER until the deferred adjudication path lands (ALI-570) - the hook is
// retrieval-only (see runAdvisory). Kept, with its tests, because deleting it cascades:
// --block-on-critical is a published flag whose only implementation is the blocking branches
// this reaches, and removing a flag makes existing committed hooks die on `unknown option`,
// breaking the fail-open contract. If ALI-570 is closed won't-do, retire this, its tests and
// the flag together in a major-version bump.
//
// Render the conflicts into whatever shape the host reads off stdout. One engine, N
// hosts - every field name here comes from that host's published hook schema:
//
//   claude  Pre: hookSpecificOutput.additionalContext, or permissionDecision:'deny'
//           Post: hookSpecificOutput.additionalContext
//   gemini  BeforeTool: decision:'deny' + reason. It has NO additionalContext channel,
//           so a non-blocking pre-check emits NOTHING and lets AfterTool carry it.
//           AfterTool: hookSpecificOutput.additionalContext
//   pi      tool_call can only block, so non-blocking findings come back as {context}
//           for the extension to replay into that call's tool_result content.
//   text    plain prose
//
// Blocking is always the opt-in `--block-on-critical` path AND only on a CRITICAL
// conflict, and never after the edit has already landed. Fail-open is the whole point:
// a guardrail that blocks on every edit gets turned off.
export function buildAdvisoryOutput(
  conflicts: AdvisoryConflict[],
  opts: AdvisoryRenderOpts,
): unknown | null {
  const closing = opts.pre
    ? 'Reconcile with these decisions or confirm with the user before writing this change.'
    : 'Reconcile with these decisions or confirm with the user before continuing.';
  const summary = conflictContext(conflicts, closing);
  const blocking = opts.pre && opts.blockOnCritical && conflicts.some((c) => c.severity === 'critical');

  return renderForHost(summary, opts, blocking);
}

// One writer of each host's output shape. Conflicts, related decisions and "could not check"
// differ only in their BODY - the wrapping is identical, so it lives here once.
function renderForHost(summary: string, opts: AdvisoryRenderOpts, blocking: boolean): unknown | null {
  const hookEventName = opts.pre ? 'PreToolUse' : 'PostToolUse';
  switch (opts.format) {
    case 'gemini':
      if (opts.pre) return blocking ? { decision: 'deny', reason: summary } : null;
      return { hookSpecificOutput: { additionalContext: summary } };

    // pi and OpenCode share this shape. Both have exactly two channels and reach them
    // differently: pi's tool_call returns {block}, OpenCode's tool.execute.before blocks
    // by throwing; pi patches tool_result.content, OpenCode mutates the result object
    // its caller then returns. Same contract, so one branch rather than two writers.
    case 'pi':
    case 'opencode':
      return blocking ? { block: true, reason: summary } : { context: summary };

    case 'text':
      return summary;

    default:
      if (blocking) {
        return { hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: summary } };
      }
      return { hookSpecificOutput: { hookEventName, additionalContext: summary } };
  }
}
