import { type Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { getBaseDiff, getCurrentBranch, getHeadDiff, getStagedDiff, isGitRepo, listBranchNames, pickBaseRef } from '../lib/git.js';
import type { AlignmentResult } from '../lib/gateway-client.js';
import { type HookPayload, readHookPayload } from '../lib/hook-payload.js';
import { decisionsThatWroteTheseLines, proposedChangeText, type RelatedDecision } from '../lib/agent/edit-text.js';
import { markHookContext } from '../lib/hook-context.js';
import { markSurfaced, recentlySurfaced } from '../lib/advisory-dedup.js';
import {
  adjudicationExistsFor,
  adjudicationPayloadPath,
  blockableVerdictFor,
  contentHashOf,
  inFlightAdjudications,
  markAdjudicationPending,
  MAX_CONCURRENT_ADJUDICATIONS,
  recordVerdict,
  type VerdictConflict,
} from '../lib/advisory-verdict.js';
import { CHECK_DEPTHS, type CheckDepth } from '../lib/check-depth.js';
import { gitHead, lastCheckFor, writeLastCheck } from '../lib/curation/last-check.js';
import { quote } from '../lib/curation/text.js';
import { detectDeterministicHits, ratifiedDeterministicRules, ruleDenyReason } from '../lib/inline-rules.js';
import { dependencyIntentQuery } from '../lib/agent/dependency-intent.js';
import { redactSecrets } from '../lib/share/secret-scan.js';
import { decisionLinkFor } from '../lib/decision-links.js';
import type { ChangeSource } from '../lib/co-change-check.js';
import type { CoChangeViolation } from '../lib/co-change.js';

// The hook budget on EVERY host is <=10s (Claude Code HOOK_TIMEOUT_SECONDS, and the 10s
// execFile timeout in the pi and OpenCode shims). Adjudication measured ~11s whenever
// retrieval returns anything, so the old synchronous check timed out on exactly the edits it
// existed for and printed nothing. Retrieval alone measured 0.4-2.4s, which fits.
const RETRIEVAL_TIMEOUT_MS = 2500;

// The hook asks for a verdict AFTER retrieval, and the whole hook answers by this deadline,
// measured from when it started. Not 10s: the host's budget also has to cover node start-up,
// the stdin read and the exit, and a hook killed at the host limit prints nothing at all,
// which is worse than a titles-only answer. A verdict that does not fit degrades to
// the titles with a line saying so (see buildRelatedOutput).
const VERDICT_DEADLINE_MS = 7000;
// Below this there is no point opening an adjudication request: only a cached or
// deterministic answer returns that fast, and retrieval has already used the time.
const MIN_VERDICT_WINDOW_MS = 500;

// Exit codes. `unknown` gets its own code rather than reusing 1: "we found
// a conflict" and "we could not look" call for different responses, and a caller that
// only tests for non-zero still treats both as a failure.
const EXIT_CONFLICT = 1;
const EXIT_UNKNOWN = 2;

function isCheckDepth(v: string): v is CheckDepth {
  return (CHECK_DEPTHS as readonly string[]).includes(v);
}

/**
 * CI identity for the check, env-supplied by the align-check action:
 * ALIGN_PLATFORM ('github-actions'), ALIGN_SUBJECT_KEY ('github:acme/repo#12'),
 * ALIGN_HEAD_SHA (the PR HEAD sha - GITHUB_SHA is the merge commit, so the action reads
 * the event payload). Environment rather than argv, deliberately: a new flag against an
 * older pinned CLI exits 1 with no JSON, decide.sh reads that as incomplete, and a
 * required gate freezes every merge - env vars an older CLI ignores decouple the action
 * bump from the CLI publish.
 *
 * Validation is fail-soft: the gateway 400s the whole check on a malformed head_sha
 * (^[0-9a-f]{7,64}$) or an oversized subject_key, and a broken attribution field must
 * cost the attribution, never the verdict. The platform gets the same treatment for a
 * different reason: it is the one field that becomes an HTTP header, and undici throws at
 * Request construction on a newline or any char above U+00FF - a throw the transport layer
 * rewrites into "Cannot reach gateway", losing the whole verdict to an attribution field.
 */
export function ciIdentityFromEnv(
  env: Record<string, string | undefined>,
): { platform?: string; subjectKey?: string; headSha?: string } {
  const platform = env['ALIGN_PLATFORM']?.trim();
  const subjectKey = env['ALIGN_SUBJECT_KEY']?.trim().slice(0, 200);
  const sha = env['ALIGN_HEAD_SHA']?.trim().toLowerCase();
  return {
    ...(platform && /^[\x21-\x7E]+$/.test(platform) ? { platform } : {}),
    ...(subjectKey ? { subjectKey } : {}),
    ...(sha && /^[0-9a-f]{7,64}$/.test(sha) ? { headSha: sha } : {}),
  };
}

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Check current changes against the decision graph (exit 1 = conflict found)')
    // `align review` is the SAME command. David Boulderstone asked for a way to ask Align
    // whether a PR is aligned with past decisions, while holding a CLI that already did it:
    // the capability was never missing, the front door was. `check` reads as "my working
    // tree right now"; `review` is the verb people reach for when they open a PR.
    .alias('review')
    .option('--env <env>', 'Environment')
    .option('--all', 'Check full HEAD diff, not just staged changes')
    .option('--hook', 'Pre-commit mode: silent on no context, only fail on critical conflicts')
    .option('--advisory', 'Agent hook mode: always exit 0, emit related (unadjudicated) decisions in the host agent\'s hook output shape. Detects pre vs post from the hook payload on stdin')
    .option('--format <format>', 'Advisory output shape for the host agent: claude (default), codex, cursor, copilot, gemini, pi, opencode, or text', 'claude')
    .option('--block-on-critical', 'Advisory hook: adjudicate each proposed change in the background, and deny a RETRY of a change already judged a critical conflict (same tool, file and text - anything else proceeds). Opt-in on purpose - in local mode adjudication calls your own AI provider, once per edit')
    .addOption(
      // The deferred adjudicator's entry point. Hidden: it is spawned by the advisory hook
      // with a payload file, never typed by a person.
      new Option('--adjudicate-deferred <file>', 'internal: run a deferred adjudication from a payload file').hideHelp(),
    )
    .option('--ci', 'CI mode: JSON output to stdout for GitHub Actions')
    .option('--json', 'Same output and exit codes as --ci: one JSON document on stdout')
    .option('--title <text>', 'The decision being proposed, in words (e.g. the PR title). Without it the gateway adjudicates on the first 200 characters of the diff, which is a file header and a few + lines')
    .option('--base <ref>', 'Diff against the merge base with <ref> (e.g. origin/main). Required in CI: a clean checkout has no staged or unstaged changes, so without it there is nothing to check and the command passes without looking')
    .option('--depth <depth>', `How deep an answer to request: ${CHECK_DEPTHS.join(', ')} - related is retrieval only, full (the gateway default) adjudicates behind its similarity cost gate, exhaustive adjudicates whatever was retrieved (for strict CI gates whose fail-on treats unknown as failure). Ignored in --advisory mode, which sets its own: retrieval, then one full check inside the hook's time budget`)
    .option('--resolve <resolution>', 'Record resolution for a conflict: <decision_id>:<type> where type is honored|overridden|context_changed')
    .action(async (opts: { env: EnvName; all: boolean; hook: boolean; advisory: boolean; blockOnCritical: boolean; adjudicateDeferred?: string; format?: AdvisoryFormat; ci: boolean; json?: boolean; base?: string; title?: string; depth?: string; resolve?: string }) => {
      // `--json` is the machine contract `--ci` already is - same document, same exit
      // codes (1 conflict, 2 unknown). One flag in the rest of this function, not two.
      if (opts.json) opts.ci = true;
      // `--hook` and `--advisory` are the two ways this command runs as an agent hook.
      // Marked once, here, before any work: the funnel emitter reads it and refuses to send,
      // because a hook firing on every edit is not a person reaching a milestone. Marked for
      // both flags rather than only --advisory, since --hook is the pre-commit hook path.
      if (opts.hook || opts.advisory) markHookContext();
      // A typo'd depth must not silently become the gateway default: for a strict CI
      // caller that quiet fall-through would reintroduce the exact unadjudicated skip
      // --depth exhaustive exists to remove. Above the advisory early-return, so
      // the typo is loud on EVERY path. Narrowing by predicate rather than a cast, so
      // deleting this guard would take the typed value with it. EXIT_UNKNOWN on both
      // branches: exit 1 is the conflict code, and a usage error reported as "found a
      // conflict" is the fabricated finding decide.sh's header documents.
      if (opts.depth !== undefined && !isCheckDepth(opts.depth)) {
        const message = `Invalid --depth '${opts.depth}': expected one of ${CHECK_DEPTHS.join(', ')}`;
        if (opts.ci) {
          process.stdout.write(`${JSON.stringify({ status: 'error', reason: 'invalid_depth', message })}\n`);
        } else {
          console.error(chalk.red(message));
        }
        process.exit(EXIT_UNKNOWN);
      }
      const depth = opts.depth as CheckDepth | undefined;

      // The spawned adjudicator. Dispatched before advisory: it is the child the
      // advisory hook launched, doing the slow full check after the hook window closed.
      if (opts.adjudicateDeferred) {
        await runDeferredAdjudication(String(opts.adjudicateDeferred), opts.env);
        return;
      }

      // Advisory mode is the deterministic auto-alignment path:
      // non-blocking, fail-open, machine-readable. It owns the whole flow, never
      // touching the human-facing spinner/console output below.
      if (opts.advisory) {
        await runAdvisory(opts.env, { blockOnCritical: opts.blockOnCritical, format: opts.format });
        return;
      }


      if (!await isGitRepo()) {
        const message = 'Not in a git repository';
        // Exit 1 is the conflict code, and this is a "could not run". In --ci the old
        // spelling also suppressed the message, so a machine got exit 1 and an empty
        // stdout - "could not look" wearing the costume of "found something", which is
        // the confusion EXIT_UNKNOWN exists to remove.
        if (opts.ci) {
          process.stdout.write(`${JSON.stringify({ status: 'error', message })}\n`);
          process.exit(EXIT_UNKNOWN);
        }
        console.error(chalk.red(message));
        process.exit(1);
      }

      // .alignrc was read here for { defaultEnv } and nothing anywhere wrote or documented it -
      // a third env-selection mechanism next to ALIGN_ENV and `align env set`, applying to this
      // one command, with an unguarded JSON.parse. Dropped.
      const envName: EnvName = resolveEnv(opts.env, { preferLocalEmbedded: true });

      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(envName));

      let diff: string;
      let autoBase: string | null = null;
      // Where the file list for a co-change rule comes from: the same source the diff came from.
      let changeSource: ChangeSource = opts.base ? { kind: 'base', ref: opts.base } : { kind: 'staged' };
      if (opts.base) {
        // An unresolvable base (a typo, a shallow clone with no history, a deleted branch)
        // must NOT fall through to the empty-diff path below: "I could not look" and "there
        // was nothing to look at" are the same green from the outside, which is the exact
        // silent pass this option exists to remove.
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
        const useHead = !diff.trim() || opts.all;
        if (useHead) {
          diff = await getHeadDiff();
          changeSource = { kind: 'head' };
        }

        // Nothing staged and nothing uncommitted. Until now that printed "No changes to check"
        // and exited 0 - on a CLEAN branch with commits, which is the normal state when you
        // open a PR. A gate that examined nothing, reporting success, and `--base` only ever
        // rescued the people who already knew to pass it.
        //
        // So fall back to the branch's own diff against its base. This fires ONLY where the
        // command was about to find nothing, so it cannot change any case that checks
        // something today - it can only turn a false green into a real check.
        //
        // Not in --ci: there `--base` is documented as required precisely so a missing flag
        // fails loudly instead of being quietly papered over by a guess.
        // NOT in --hook. Copilot, #309: a pre-commit hook is documented as silent when there
        // is no context (docs/check.md), and this fallback would make it check every commit on
        // the branch - emitting output, and able to fail the commit on an unrelated historical
        // conflict the author is not touching. Nor in --ci, where --base is required precisely
        // so a missing flag fails loudly instead of being papered over by a guess.
        if (!diff.trim() && !opts.ci && !opts.hook) {
          const detected = pickBaseRef(await listBranchNames());
          if (detected) {
            const branchDiff = await getBaseDiff(detected).catch(() => '');
            if (branchDiff.trim()) {
              diff = branchDiff;
              autoBase = detected;
              changeSource = { kind: 'base', ref: detected };
            }
          }
        }
      }

      if (autoBase && !opts.hook) {
        console.log(chalk.dim(`No staged or uncommitted changes - reviewing this branch against ${autoBase}.`));
      }

      if (!diff.trim()) {
        if (!opts.hook && !opts.ci) console.log(chalk.dim('No changes to check.'));
        process.exit(0);
      }

      const branch = await getCurrentBranch().catch(() => '');
      // One options object for both paths below, so the CI request and the interactive
      // request cannot silently diverge field by field.
      const checkOpts = { title: opts.title, depth, ...ciIdentityFromEnv(process.env) };

      // Co-change rules ("a PR touching X must also touch Y") are a question about which files changed,
      // so they are computed here from the file list and need no model. Not in --hook: that runs on one
      // commit, and a same-PR rule cannot be judged from one commit of a PR.
      let violations: CoChangeViolation[] = [];
      if (!opts.hook) {
        const envConfig = config.getEnvironment(envName);
        if (envConfig.mode === 'local-embedded') {
          try {
            violations = await (await import('../lib/co-change-check.js')).coChangeViolations(envConfig, changeSource);
          } catch (err) {
            const message = `Could not evaluate co-change rules: ${(err as Error).message}`;
            if (opts.ci) {
              process.stdout.write(`${JSON.stringify({ status: 'unknown', reason: 'co_change_unavailable', message })}\n`);
            } else {
              console.error(chalk.red(message));
            }
            process.exit(EXIT_UNKNOWN);
          }
        }
      }
      const judge = async (): Promise<AlignmentResult> => {
        const call = () => client.checkAlignment(diff, branch, checkOpts);
        return violations.length === 0 ? call() : (await import('../lib/co-change-check.js')).judgeWithCoChange(call, violations);
      };

      if (opts.ci) {
        try {
          const result = await judge();
          // LM: stdout is the machine contract (notes ride in the JSON); a person reading the CI log sees them on stderr.
          for (const note of result.notes ?? []) process.stderr.write(`${note}\n`);
          process.stdout.write(`${JSON.stringify(result)}\n`);
          if (result.status === 'conflicting') process.exit(EXIT_CONFLICT);
          // CI is where a silent green costs the most: a check that could not run
          // must not be indistinguishable from a check that found nothing.
          // `retrieved` joins `unknown` here: decisions came back unadjudicated, so nothing
          // was verified and a 0 would read as a clean check.
          process.exit(
            result.status === 'unknown' || result.status === 'retrieved' ? EXIT_UNKNOWN : 0,
          );
        } catch (err) {
          // EXIT_UNKNOWN, not 0: the check request failed (network/auth/etc.), so nothing was verified, and
          // the two lines above exist to keep that distinguishable from a clean check.
          // Exiting 0 here made an outage (or auth failure) a silent green for any runner following the
          // documented exit-code contract. The status stays `error` rather than `unknown` - `unknown` is
          // the graph deliberately declining to classify, while this is an execution/transport failure.
          process.stdout.write(`${JSON.stringify({ status: 'error', message: (err as Error).message })  }\n`);
          process.exit(EXIT_UNKNOWN);
        }
      }

      const spinner = ora('Checking alignment...').start();
      try {
        const result = await judge();
        spinner.stop();
        // LM: what this person's marks did to the result, and the file set `align mark check` defaults to.
        for (const note of result.notes ?? []) console.log(chalk.dim(`  ${note}`));
        if (!opts.hook) writeLastCheck(lastCheckFor(diff, result, undefined, undefined, await gitHead()));

        if (result.status === 'aligned') {
          console.log(chalk.green('\n  Aligned with decision graph.\n'));
          for (const d of result.relevant_decisions.slice(0, 3)) {
            console.log(`  ${chalk.green('+')} ${chalk.bold(d.title)}${d.successor ? chalk.yellow(` (superseded by ${quote(d.successor.title)})`) : ''}`);
            if (d.summary) {
              const snippet = d.summary.slice(0, 120).replace(/\n/g, ' ');
              console.log(chalk.dim(`    "${snippet}${d.summary.length > 120 ? '...' : ''}"`));
            }
            const link = decisionLinkFor(d);
            if (link) console.log(chalk.dim(`    ${link}`));
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
            const link = decisionLinkFor(c);
            if (link) console.log(chalk.dim(`           ${link}`));
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
          // The check did not run. Never a green header, and never the
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
            const link = decisionLinkFor(d);
            if (link) console.log(chalk.dim(`    ${link}`));
            console.log('');
          }
          // Pre-commit hook mode stays non-blocking (its contract is "only fail on
          // critical conflicts"): a user with no LLM key would otherwise have every
          // commit rejected and would just uninstall the hook. It is no longer
          // SILENT, though - the lines above still print.
          if (opts.hook) process.exit(0);
          process.exit(EXIT_UNKNOWN);
        } else if (result.status === 'retrieved') {
          // Retrieval without adjudication, the third member of the family this file's fail-closed
          // comments are about: not a pass, and emphatically not "nothing found", because
          // relevant_decisions is populated. Only the advisory hook asks for it today, and it
          // reads relevant_decisions rather than status - so this branch exists so that adding
          // `depth` to either call above cannot silently render decisions as an empty graph.
          if (!opts.hook) {
            console.log(
              chalk.yellow(
                `\n  ${result.relevant_decisions.length} related decision(s) retrieved but NOT adjudicated - review them by hand.\n`,
              ),
            );
            for (const d of result.relevant_decisions) console.log(chalk.dim(`  - ${d.title}`));
          }
          if (opts.hook) process.exit(0);
          process.exit(EXIT_UNKNOWN);
        } else {
          // LM: when marks are part of the answer, say what they did instead of "found nothing".
          if (!opts.hook) console.log(chalk.dim(`\n  ${result.notes?.length ? result.message : 'No related decisions found in your graph.'}\n`));
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
//   - PreToolUse  -> check the PROPOSED edit before it is written
//   - PostToolUse -> check the landed working-tree diff; also the path for
//     a manual `align check --advisory` run with no piped payload.
// Anything else (no repo, no diff, gateway down/slow, aligned) stays silent.
// Fail-open is the whole point - a hook that blocks or errors on every edit gets disabled.
async function runAdvisory(env: EnvName, opts: { blockOnCritical?: boolean; format?: AdvisoryFormat } = {}): Promise<void> {
  const startedAt = Date.now();
  try {
    const payload = await readHookPayload();
    const pre = payload?.hook_event_name === 'PreToolUse';

    // A USER-level hook does not run in the project (Cursor documents that user-level hook
    // scripts run from ~/.cursor/), and everything below - the post-edit git diff, the
    // dedup store, the verdict store - keys on process.cwd(). Move to the workspace the
    // host named before touching any of them. Fail-open: a cwd that does not exist is left
    // alone and the check proceeds wherever it was started.
    if (payload?.cwd && existsSync(payload.cwd)) {
      try {
        process.chdir(payload.cwd);
      } catch {
        // Stay put.
      }
    }

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

    // A RATIFIED deterministic rule stops the FIRST attempt, inline. The pure
    // matcher runs first and costs nothing; the tenant's rules are fetched only when it hits,
    // so an ordinary edit pays no request. No ratified rule, an unreadable answer or local
    // mode (no starter rules) all fall through to the normal path: a deny rests on a person
    // having said "enforce this", never on a guess. Pre only - a landed edit cannot be refused.
    // Break glass: ALIGN_RULES_ACK=1 skips this check for the session. The deny says
    // "confirm with the user", and nothing else records that confirmation, so without a way
    // out an agent retrying identical text would be refused forever.
    // Deliberately NOT gated on --block-on-critical: that flag opts into blocking on a model's
    // guess; this denies only what a person ratified AND a computed match proves.
    if (pre && process.env.ALIGN_RULES_ACK !== '1') {
      const hits = detectDeterministicHits(text);
      if (hits.length) {
        let denial: unknown | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Local mode has no starter rules: skip without a misleading note.
          if (typeof client.getStarterRules !== 'function' || envName === 'local') throw new LocalSkip();
          const ratified = ratifiedDeterministicRules(
            await Promise.race([
              client.getStarterRules(),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), RETRIEVAL_TIMEOUT_MS); }),
            ]),
          );
          const broken = hits.flatMap((h) => {
            const rule = ratified.get(h.ruleId);
            return rule ? [{ rule, kind: h.kind }] : [];
          });
          if (broken.length) denial = renderForHost(ruleDenyReason(broken), renderOpts, true);
        } catch (err) {
          if (!(err instanceof LocalSkip)) process.stderr.write('align: this edit matches a starter rule, but could not read your ratified rules, so it was not checked against them.\n');
        }
        clearTimeout(timer);
        if (denial !== null) {
          emit(denial);
          process.exit(0);
        }
      }
    }

    // A deferred verdict answers a RETRY before any retrieval runs. CHANGE
    // identity, not file identity and not text identity - only a proposal matching what the
    // background adjudicator actually judged is answered here, so an adjusted approach
    // hashes differently and goes through the normal path. Everything below the flag check
    // is opt-in: without `--block-on-critical` there is no store lookup, no spawn, and (in
    // local mode) no provider call, which is the egress default #143 established and this
    // must not erode.
    const cwd = process.cwd();
    const identity = changeIdentityOf(payload);
    const filePath = identity.filePath;
    const contentHash = pre ? identityHashOf(identity) : null;
    if (opts.blockOnCritical && contentHash) {
      const verdict = blockableVerdictFor(cwd, envName, contentHash, filePath);
      if (verdict && verdict.conflicts.length) {
        // buildAdvisoryOutput decides blocking: deny only on pre + flag + a CRITICAL
        // conflict (its own tested contract). Warnings surface as context.
        const rendered = buildAdvisoryOutput(verdict.conflicts, renderOpts);
        // A null render means this host has no pre-edit channel for non-blocking context
        // (gemini's BeforeTool reads decision/reason and nothing else). Exiting here would
        // spend the verdict on silence AND skip retrieval, so fall through instead and let
        // the normal path deliver what that host can actually receive.
        if (rendered !== null) {
          // Record the decisions as surfaced, or the sibling PostToolUse hook repeats them
          // moments later - the duplication advisory-dedup exists to prevent.
          markSurfaced(cwd, verdict.conflicts.map((c) => c.decision_id).filter(Boolean));
          emit(rendered);
          process.exit(0);
        }
      }
    }

    // Retrieval comes first and is what the hook always has to give: it is fast and it names
    // the subject. A verdict (`depth: 'full'`, adjudicated) is requested only AFTER retrieval
    // finds something, and only inside the deadline above - adjudication measures ~11s when it
    // has to call the model, so it often will not fit, and then the titles go out as before.
    // Runs beside retrieval, not before it: blame is local and bounded, so it adds nothing to the
    // hook's wall clock. PRE only - a landed edit has no "lines about to change".
    const writtenBy = pre ? decisionsThatWroteTheseLines(client, payload?.tool_input, cwd) : Promise.resolve<RelatedDecision[]>([]);
    let found: RelatedDecision[] | null = null;
    let markNotes: string[] = [];
    // A dependency the edit adds is a sentence retrieval can match; raw JSON or an import line is not
    // (src/lib/agent/dependency-intent.ts). Asked beside the raw text, in the same retrieval window.
    const depQuery = dependencyIntentQuery(payload?.tool_input, payload?.cwd ?? cwd);
    const related = (query: string): Promise<AlignmentResult | null> =>
      Promise.race([
        // The SAME embedding retrieval `align check` uses, minus the adjudication. Plain
        // `searchDecisions` is keyword-based and returns nothing for a sentence of edit
        // content, which is why this path needed gateway #1415 rather than the search API.
        client.checkAlignment(query, context, { depth: 'related' }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), RETRIEVAL_TIMEOUT_MS)),
      ]);
    try {
      const [result, depResult] = await Promise.all([
        related(text),
        depQuery ? related(depQuery).catch(() => null) : Promise.resolve(null),
      ]);
      const merged = mergeRelated(result?.relevant_decisions, depResult?.relevant_decisions);
      found = result === null && depResult === null ? null : merged;
      markNotes = result?.notes ?? [];
    } catch {
      found = null;
    }

    // Decisions the sibling hook already showed the agent moments ago are not repeated.
    const seen = recentlySurfaced(cwd);
    const wrote = (await writtenBy).filter((d) => !seen.has(d.id));

    if (found === null) {
      // Never silent on a non-answer. The writers are a deterministic answer in their own right.
      if (wrote.length) markSurfaced(cwd, wrote.map((d) => d.id));
      emit(wrote.length ? buildRelatedOutput([], renderOpts, wrote, true) : buildUnknownOutput(renderOpts));
      process.exit(0);
    }

    // LM: what a person's marks left out or an agent's marks changed, on stderr beside the hook JSON on stdout.
    for (const note of markNotes) process.stderr.write(`${note}\n`);

    // Genuinely nothing related: a real answer, so staying quiet is honest here - unless blame
    // named the decision that wrote these lines.
    if (!found.length && !wrote.length) process.exit(0);

    const writerIds = new Set(wrote.map((d) => d.id));
    const fresh = found.filter((d) => !seen.has(d.id) && !writerIds.has(d.id));

    // The verdict. Only for decisions this hook is about to show: a sibling hook that already
    // showed them has said its piece, and a blame-only answer is a deterministic one that
    // needs no model. Not in local mode: there adjudication is the pipeline's only provider
    // egress (#143 turned it off by default, deliberately), and this must not erode that.
    let verdict: VerdictOutcome = { kind: 'not_requested' };
    if (fresh.length && envName !== 'local') {
      verdict = await requestVerdict(client, text, context, VERDICT_DEADLINE_MS - (Date.now() - startedAt));
    }
    const judged = verdict.kind === 'conflicting' || verdict.kind === 'aligned';

    // Under `--block-on-critical` a verdict in hand is stored for the RETRY, as the background
    // adjudicator would have stored it. The flag keeps its meaning: it denies a retry of a
    // change already judged critical, never the first attempt (the render below is
    // non-blocking). The same record stops the next edit of this content adjudicating again.
    if (pre && opts.blockOnCritical && contentHash && judged) {
      recordVerdict(cwd, envName, {
        ts: Date.now(),
        filePath: identity.filePath,
        contentHash,
        adjudicated: true,
        conflicts: verdict.kind === 'conflicting' ? verdict.conflicts : [],
      });
    }

    // When the verdict did not fit the window, the proposed content is still worth the slow
    // full check - AFTER this hook returns. Spawned detached and unref'd so the
    // hook's exit is never coupled to the adjudicator's lifetime. PRE only: the proposed
    // text is the artefact a retry re-presents byte-for-byte, where the POST diff is already
    // landed and matches nothing an agent will propose again.
    //
    // TWO separate bounds, because they cover different things. The hash check only catches
    // a re-proposal of the SAME change, which is the rare case - an agent iterating produces
    // different content every time and would otherwise spawn one adjudicator per edit. The
    // in-flight cap is what actually bounds the cost. Being over the cap loses a verdict,
    // never an edit, and the next hook invocation tries again.
    if (pre && opts.blockOnCritical && contentHash && !judged && !adjudicationExistsFor(cwd, envName, contentHash)) {
      if (inFlightAdjudications(cwd, envName) < MAX_CONCURRENT_ADJUDICATIONS) {
        spawnDeferredAdjudication({ identity, context, cwd, contentHash }, envName);
      }
    }

    if (fresh.length || wrote.length) {
      markSurfaced(cwd, [...wrote, ...fresh].map((d) => d.id));
      emit(buildRelatedOutput(fresh, renderOpts, wrote, false, verdict));
    }
  } catch {
    // Fail open: swallow everything (gateway error, network, bad config).
  }
  process.exit(0);
}

class LocalSkip extends Error {}

/**
 * What asking for a verdict came back with. `timeout` and `no_verdict` are both "could not
 * check" and must never render as a pass: `unknown` is not aligned, and neither is silence.
 */
type VerdictOutcome =
  | { kind: 'not_requested' }
  | { kind: 'aligned'; checked: number }
  | { kind: 'conflicting'; conflicts: VerdictConflict[] }
  | { kind: 'timeout' }
  | { kind: 'no_verdict' };

/**
 * One adjudicated check, bounded by `budgetMs`. Never throws: every way of not getting an
 * answer is a named outcome the renderer words honestly. A request that outlives the budget
 * is abandoned, not awaited - the hook exits and the process takes it down.
 */
async function requestVerdict(
  client: ReturnType<typeof createGatewayClient>,
  text: string,
  context: string,
  budgetMs: number,
): Promise<VerdictOutcome> {
  if (budgetMs < MIN_VERDICT_WINDOW_MS) return { kind: 'timeout' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      client.checkAlignment(text, context, { depth: 'full' }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); }),
    ]);
    if (result === null) return { kind: 'timeout' };
    if (result.status === 'conflicting' && result.conflicts?.length) return { kind: 'conflicting', conflicts: result.conflicts };
    if (result.status === 'aligned') return { kind: 'aligned', checked: result.relevant_decisions?.length ?? 0 };
    return { kind: 'no_verdict' };
  } catch {
    return { kind: 'no_verdict' };
  } finally {
    clearTimeout(timer);
  }
}

type AdvisoryConflict = NonNullable<AlignmentResult['conflicts']>[number];

/**
 * Ceiling on one deferred adjudication. Generous next to the ~11s a real check takes,
 * because this is a backstop against a stalled gateway rather than a latency budget - the
 * hook has already returned, so nobody is waiting on it.
 */
const ADJUDICATION_TIMEOUT_MS = 120_000;

interface AdjudicationPayload {
  identity: ChangeIdentity;
  context: string;
  cwd: string;
  /** Carried so the child can re-derive it and refuse a payload it does not match. */
  contentHash: string;
}

/**
 * Launch the deferred adjudicator. The payload travels by FILE, never argv:
 * proposed content is arbitrary text of arbitrary size, and an argv would also parade it
 * through `ps`. Fail-open like everything else on the advisory path - a spawn that cannot
 * happen costs a verdict, never an edit.
 */
function spawnDeferredAdjudication(payload: AdjudicationPayload, envName: EnvName): void {
  try {
    // 0600, inside our own 0700 directory, under an unguessable name. The file holds the
    // user's proposed source, and on a shared Linux /tmp the old predictable 0644 path was
    // both readable by other uids and pre-plantable as a symlink.
    const file = adjudicationPayloadPath(payload.contentHash);
    if (!file) return;
    writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    markAdjudicationPending(payload.cwd, envName, payload.contentHash);
    // process.argv[1] is this CLI's own entry point, however it was installed. The env
    // travels on argv and NOT in the payload, so there is one writer of it rather than a
    // serialised copy nothing reads.
    const child = spawn(
      process.execPath,
      [process.argv[1] ?? 'align', 'check', '--adjudicate-deferred', file, '--env', envName],
      { detached: true, stdio: 'ignore' },
    );
    // spawn() reports failure ASYNCHRONOUSLY, so the try/catch around it cannot see an
    // ENOENT/EMFILE/EAGAIN - the event goes unhandled and takes the hook down with it.
    // Nothing reaches the event loop before process.exit(0) today, which means this listener
    // is invisible protection: it exists so that adding any await above stays safe.
    child.on('error', () => {
      try {
        unlinkSync(file);
      } catch {
        // The child may already have taken it.
      }
    });
    child.unref();
  } catch {
    // Best-effort: the pending marker (if written) expires on its own.
  }
}

/**
 * The adjudicator: the slow full check, run after the hook window has closed. Its whole
 * output is one verdict row; a clean or unknowable result records an EMPTY verdict so the
 * same content is not re-adjudicated inside the TTL. `unknown` maps to empty deliberately -
 * could-not-check must stay fail-open, and a deny may only rest on an adjudicated
 * CRITICAL conflict. Always exits 0: nothing downstream reads this process's exit code, and
 * a crash here must never surface as anything at all.
 */
async function runDeferredAdjudication(payloadFile: string, env: EnvName): Promise<void> {
  try {
    const raw = readFileSync(payloadFile, 'utf8');
    // Unlink BEFORE parsing: the file is transport, not state, and a parse failure must not
    // leave the user's proposed source lying in tmp until the OS reaps it.
    try {
      unlinkSync(payloadFile);
    } catch {
      // Already gone is fine.
    }
    const payload = JSON.parse(raw) as AdjudicationPayload;
    // The payload crossed a file, so "the hash names this text" is a premise rather than a
    // guarantee. Recomputing it costs one sha1 and is the only thing standing between a
    // swapped payload and a deny bound to content nobody judged.
    if (!payload.identity || identityHashOf(payload.identity) !== payload.contentHash) return;
    const envName: EnvName = resolveEnv(env, { preferLocalEmbedded: true });
    const client = createGatewayClient(createConfigStore().getEnvironment(envName));
    // The cloud client passes no AbortSignal, so a stalled gateway would keep this detached
    // process alive on undici's defaults with nothing watching it. Bound it here.
    const result = await Promise.race([
      client.checkAlignment(payload.identity.text, payload.context, {}),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('adjudication timed out')), ADJUDICATION_TIMEOUT_MS).unref(),
      ),
    ]);
    // `conflicting` is the ONLY status that may yield blockable conflicts. `unknown` records
    // an unadjudicated row: could-not-check stays fail-open, and unlike a clean
    // verdict it must not suppress a retry for the full 15 minutes, or a user with no
    // provider gets a flag that is silently inert.
    const adjudicated = result.status !== 'unknown';
    const conflicts = result.status === 'conflicting' ? (result.conflicts ?? []) : [];
    recordVerdict(payload.cwd, envName, {
      ts: Date.now(),
      filePath: payload.identity.filePath,
      contentHash: payload.contentHash,
      adjudicated,
      conflicts,
    });
  } catch {
    // Fail open: no verdict. The pending marker expires (PENDING_TTL_MS) and a later hook
    // invocation may spawn a fresh attempt.
  } finally {
    // In a `finally` so EVERY path exits 0, the early returns above included. Sitting after
    // the catch, it was skipped by an early return, leaving the "always exits 0" contract to
    // whether the event loop happened to be empty.
    process.exit(0);
  }
}


// Decisions from the raw-text retrieval first, then any the dependency sentence added, one per id.
function mergeRelated<T extends { id: string }>(a: T[] | undefined, b: T[] | undefined): T[] {
  const seen = new Set<string>();
  return [...(a ?? []), ...(b ?? [])].filter((d) => !seen.has(d.id) && !!seen.add(d.id));
}

// What each listed decision says, so a heading-only title ("Architecture") is not all the agent
// gets. Per decision, and in total across the block: hooks have small context budgets.
export const EXCERPT_BUDGET_CHARS = 200;
export const EXCERPT_TOTAL_BUDGET_CHARS = 800;
// Below this a cut excerpt is a fragment, so the decision keeps its title alone.
const MIN_EXCERPT_CHARS = 40;

const flatten = (t: string): string => t.replace(/\s+/g, ' ').trim();
// C0 controls (bar tab, LF, CR, which flatten already turned into spaces) and DEL: an ESC sequence in a
// stored decision must not reach the agent's context or a terminal.
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;
// A decision that came from a commit: its source is a /commit/<sha> URL (local and cloud both carry it).
const isCommitSource = (url: string | undefined): boolean => /\/commit\/[0-9a-f]{7,40}(?:[/?#]|$)/i.test(url ?? '');

// A commit summary is `subject, body, Author, Date, Files changed` (formatCommitAsText), plus any
// trailers the body carries. The metadata is noise that would eat the budget. Commits only: a doc
// section may legitimately hold a line that starts with "Date:".
function stripCommitMetadata(text: string): string {
  const lines = text.split('\n');
  const stop = lines.findIndex((l) => /^\s*(Author|Date|Files changed):/.test(l));
  return (stop === -1 ? lines : lines.slice(0, stop)).filter((l) => !/^\s*(Co-Authored-By|Signed-off-by):/i.test(l)).join('\n');
}

// The title is already printed. Drop a leading copy of it when it is a LINE of its own (a commit
// subject), never a prefix of a sentence: its words match across any whitespace, and only when a line
// break or the end follows.
function dropLeadingTitle(text: string, title: string): string {
  const words = flatten(title).split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(new RegExp(`^\\s*${words.join('\\s+')}[^\\S\\n]*(\\n|$)`), '');
}

function excerptOf(d: RelatedDecision, room: number): string {
  // Redact first, on the whole text: a secret cut in half by the budget would no longer match its pattern.
  const redacted = redactSecrets(d.summary ?? '').text;
  const own = dropLeadingTitle(isCommitSource(d.url) ? stripCommitMetadata(redacted) : redacted, d.title);
  // By code point, so the cut can never split a surrogate pair.
  const chars = Array.from(flatten(own).replace(CONTROLS, ''));
  const limit = Math.min(EXCERPT_BUDGET_CHARS, room);
  if (limit < MIN_EXCERPT_CHARS) return '';
  if (chars.length <= limit) return chars.join('');
  const cut = chars.slice(0, limit - 3);
  // Cut on a word boundary: drop the partial word unless the cut already fell on a space.
  const atBoundary = chars[limit - 3] === ' ';
  const body = atBoundary ? cut.join('') : cut.join('').replace(/\s+\S*$/, '');
  return `${body.trimEnd()}...`;
}

// A decision a person marked as replaced still comes back from retrieval (local mode carries `status` and
// `successor`); the agent must not follow it as current. Only the local result carries this today.
function replacedNote(d: RelatedDecision): string {
  if (d.status !== 'superseded') return '';
  return d.successor?.title ? ` (replaced by: ${safeTitle(d.successor.title)})` : ' (replaced)';
}

// A title reaches the agent too, so it gets the excerpt's redaction and control stripping.
function safeTitle(title: string): string {
  return flatten(redactSecrets(title).text).replace(CONTROLS, '');
}

// One writer of the bullet format. `budget.left` is shared by every list in one output.
function decisionBullets(decisions: RelatedDecision[], budget: { left: number }): string[] {
  return decisions.flatMap((d) => {
    const excerpt = excerptOf(d, budget.left);
    budget.left -= excerpt.length;
    const head = `- ${safeTitle(d.title)}${replacedNote(d)}`;
    return excerpt ? [head, `  ${excerpt}`] : [head];
  });
}

// Retrieval finds decisions on the same SUBJECT. It does not encode opposition - a measurement
// put the agreeing pair at cosine 0.38 against the contradicting pair at 0.31 - so this
// wording must never assert a conflict. Saying "related" is the honest claim and the useful one.
export function buildRelatedOutput(
  decisions: RelatedDecision[],
  opts: AdvisoryRenderOpts,
  wrote: RelatedDecision[] = [],
  retrievalFailed = false,
  verdict: VerdictOutcome = { kind: 'not_requested' },
): unknown | null {
  const budget = { left: EXCERPT_TOTAL_BUDGET_CHARS };
  // `git blame` names these deterministically: they are not a guess about the subject, they put these exact lines here.
  const writerBlock = wrote.length
    ? [
        `Align decision graph: the lines this edit changes were written by ${wrote.length > 1 ? `${wrote.length} prior decisions` : 'a prior decision'} (found with git blame, not content search):`,
        ...decisionBullets(wrote, budget),
        'Check that this change still honours what they decided before continuing.',
      ]
    : [];
  const closing = opts.pre
    ? 'Reconcile with these decisions or confirm with the user before writing this change.'
    : 'Reconcile with these decisions or confirm with the user before continuing.';
  // An adjudicated answer replaces the "related, not adjudicated" block: it says more.
  const verdictBlock =
    verdict.kind === 'conflicting'
      ? [conflictContext(verdict.conflicts, closing)]
      : verdict.kind === 'aligned'
        ? [`Align decision graph: checked this change against ${verdict.checked || 'the'} related decision${verdict.checked === 1 ? '' : 's'} and found no conflict.`]
        : [];
  const related = verdictBlock.length
    ? verdictBlock
    : decisions.length
    ? [
        `${wrote.length ? 'Also, ' : 'Align decision graph: '}${decisions.length} prior decision${decisions.length > 1 ? 's relate' : ' relates'} to this change:`,
        ...decisionBullets(decisions, budget),
        'These are related by content search and have NOT been adjudicated. Check whether any of them opposes this change before continuing.',
      ]
    : [];
  const summary = [
    ...writerBlock,
    ...related,
    // Titles with no verdict: say why, and never let it read as a pass.
    ...(verdict.kind === 'timeout'
      ? ['Align could not check this change in time, so there is no verdict and the change is UNVERIFIED.']
      : verdict.kind === 'no_verdict'
        ? ['Align could not reach a verdict on this change, so it is UNVERIFIED.']
        : []),
    ...(retrievalFailed ? ['Align could not check this change against the rest of the decision graph (retrieval failed or timed out); treat the rest as UNVERIFIED.'] : []),
    // The model is the only reader of this text; without this line the user cannot tell the hook ran.
    'Tell the user in one line which of these you checked against and whether this change agrees with it.',
  ].join('\n');
  return renderForHost(summary, opts, false);
}

// A check that could not run is not a pass. Silence here would be
// indistinguishable from "nothing found", which is the exact fail-open both tickets closed.
export function buildUnknownOutput(opts: AdvisoryRenderOpts): unknown | null {
  const summary = [
    'Align could not check this change against the decision graph (retrieval failed or timed out).',
    'Treat it as UNVERIFIED rather than approved - run `align check` manually if it matters.',
  ].join('\n');
  return renderForHost(summary, opts, false);
}

/**
 * What a deferred verdict is stored and matched under: the PROPOSED CHANGE, and
 * deliberately not just its text.
 *
 * `proposedChangeText` is a lossy projection. An Edit's `new_string` and a Write's
 * whole-file `content` can be byte-identical while being completely different proposals,
 * and the same `new_string` aimed at another file is a third. Keying a deny on the text
 * alone lets one verdict answer all three, which is exactly the "denies an unrelated later
 * edit" failure the whole design is meant to avoid.
 */
interface ChangeIdentity {
  toolName: string;
  filePath: string;
  oldString: string;
  text: string;
}

function changeIdentityOf(payload: HookPayload | null): ChangeIdentity {
  const input = payload?.tool_input;
  return {
    toolName: payload?.tool_name ?? '',
    filePath: input?.file_path ?? '',
    oldString: typeof input?.old_string === 'string' ? input.old_string : '',
    text: proposedChangeText(input),
  };
}

/**
 * ONE writer of the identity format, used by the hook that stores a key and by the
 * adjudicator that re-derives it. Two implementations of this would be two writers of one
 * fact, and they would disagree silently - a verdict nothing can ever match. NUL separates
 * the fields so concatenation cannot forge a collision across them.
 */
function identityHashOf(id: ChangeIdentity): string {
  return contentHashOf([id.toolName, id.filePath, id.oldString, id.text].join('\0'));
}

// Render conflicts as a concise, actionable nudge for the agent's context.
function conflictContext(conflicts: AdvisoryConflict[], closing: string): string {
  const lines = conflicts.map((c) => {
    const reason = c.reason && c.reason !== 'Conflicts with an existing team decision' ? ` - ${c.reason}` : '';
    const link = decisionLinkFor(c);
    const url = link ? ` (${link})` : '';
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
export type AdvisoryFormat = 'claude' | 'codex' | 'cursor' | 'copilot' | 'gemini' | 'pi' | 'opencode' | 'text';

export interface AdvisoryRenderOpts {
  pre: boolean;
  format: AdvisoryFormat;
  blockOnCritical: boolean;
}

// Called from runAdvisory's deferred-verdict short-circuit: the hook itself is
// retrieval-only, so the ONLY thing that reaches these blocking branches is a verdict the
// background adjudicator recorded for this exact change.
//
// Render the conflicts into whatever shape the host reads off stdout. One engine, N
// hosts - every field name here comes from that host's published hook schema:
//
//   claude  Pre: hookSpecificOutput.additionalContext, or permissionDecision:'deny'
//           Post: hookSpecificOutput.additionalContext
//   codex   Claude Code's shape verbatim (Codex hooks reference documents the same
//           hookSpecificOutput block, additionalContext included).
//   cursor  preToolUse reads {permission, user_message, agent_message} and nothing else,
//           so a non-blocking pre-check emits NOTHING; postToolUse carries
//           {additional_context}. The Gemini split.
//   copilot preToolUse reads {permissionDecision, permissionDecisionReason}; postToolUse
//           carries {additionalContext}. Same split. A non-zero exit DENIES there, which
//           is one more reason this command exits 0 without exception.
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

    case 'cursor':
      if (opts.pre) return blocking ? { permission: 'deny', user_message: summary, agent_message: summary } : null;
      return { additional_context: summary };

    case 'copilot':
      if (opts.pre) return blocking ? { permissionDecision: 'deny', permissionDecisionReason: summary } : null;
      return { additionalContext: summary };

    case 'text':
      return summary;

    case 'codex':
    default:
      if (blocking) {
        return { hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: summary } };
      }
      return { hookSpecificOutput: { hookEventName, additionalContext: summary } };
  }
}
