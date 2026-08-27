import { type Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { getBaseDiff, getCurrentBranch, getHeadDiff, getStagedDiff, isGitRepo } from '../lib/git.js';
import type { AlignmentResult } from '../lib/gateway-client.js';
import { type HookPayload, type HookToolInput, readHookPayload } from '../lib/hook-payload.js';
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
} from '../lib/advisory-verdict.js';
import { CHECK_DEPTHS, type CheckDepth } from '../lib/check-depth.js';

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

function isCheckDepth(v: string): v is CheckDepth {
  return (CHECK_DEPTHS as readonly string[]).includes(v);
}

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Check current changes against the decision graph (exit 1 = conflict found)')
    .option('--env <env>', 'Environment')
    .option('--all', 'Check full HEAD diff, not just staged changes')
    .option('--hook', 'Pre-commit mode: silent on no context, only fail on critical conflicts')
    .option('--advisory', 'Agent hook mode: always exit 0, emit related (unadjudicated) decisions in the host agent\'s hook output shape. Detects pre vs post from the hook payload on stdin')
    .option('--format <format>', 'Advisory output shape for the host agent: claude (default), gemini, pi, opencode, or text', 'claude')
    .option('--block-on-critical', 'Advisory hook: adjudicate each proposed change in the background, and deny a RETRY of a change already judged a critical conflict (same tool, file and text - anything else proceeds). Opt-in on purpose - in local mode adjudication calls your own AI provider, once per edit (ALI-570)')
    .addOption(
      // The deferred adjudicator's entry point. Hidden: it is spawned by the advisory hook
      // with a payload file, never typed by a person.
      new Option('--adjudicate-deferred <file>', 'internal: run a deferred adjudication from a payload file').hideHelp(),
    )
    .option('--ci', 'CI mode: JSON output to stdout for GitHub Actions')
    .option('--title <text>', 'The decision being proposed, in words (e.g. the PR title). Without it the gateway adjudicates on the first 200 characters of the diff, which is a file header and a few + lines')
    .option('--base <ref>', 'Diff against the merge base with <ref> (e.g. origin/main). Required in CI: a clean checkout has no staged or unstaged changes, so without it there is nothing to check and the command passes without looking')
    .option('--depth <depth>', `How deep an answer to request: ${CHECK_DEPTHS.join(', ')} - related is retrieval only, full (the gateway default) adjudicates behind its similarity cost gate, exhaustive adjudicates whatever was retrieved (for strict CI gates whose fail-on treats unknown as failure, ALI-708). Ignored in --advisory mode, which is retrieval-only by design`)
    .option('--resolve <resolution>', 'Record resolution for a conflict: <decision_id>:<type> where type is honored|overridden|context_changed')
    .action(async (opts: { env: EnvName; all: boolean; hook: boolean; advisory: boolean; blockOnCritical: boolean; adjudicateDeferred?: string; format?: AdvisoryFormat; ci: boolean; base?: string; title?: string; depth?: string; resolve?: string }) => {
      // A typo'd depth must not silently become the gateway default: for a strict CI
      // caller that quiet fall-through would reintroduce the exact unadjudicated skip
      // --depth exhaustive exists to remove (ALI-708). Above the advisory early-return, so
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

      // The spawned adjudicator (ALI-570). Dispatched before advisory: it is the child the
      // advisory hook launched, doing the slow full check after the hook window closed.
      if (opts.adjudicateDeferred) {
        await runDeferredAdjudication(String(opts.adjudicateDeferred), opts.env);
        return;
      }

      // Advisory mode is the deterministic auto-alignment path (ALI-121/ALI-122):
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
      // One options object for both paths below, so the CI request and the interactive
      // request cannot silently diverge field by field.
      const checkOpts = { title: opts.title, depth };

      if (opts.ci) {
        try {
          const result = await client.checkAlignment(diff, branch, checkOpts);
          process.stdout.write(`${JSON.stringify(result)}\n`);
          if (result.status === 'conflicting') process.exit(EXIT_CONFLICT);
          // CI is where a silent green costs the most: a check that could not run
          // must not be indistinguishable from a check that found nothing (ALI-414).
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
        const result = await client.checkAlignment(diff, branch, checkOpts);
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
        } else if (result.status === 'retrieved') {
          // Retrieval without adjudication, the third member of the family this file's ALI-414
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

    // ALI-570: a deferred verdict answers a RETRY before any retrieval runs. CHANGE
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

    // ALI-570: retrieval found decisions on this subject, so the proposed content is worth
    // the slow full check - AFTER this hook returns. Spawned detached and unref'd so the
    // hook's exit is never coupled to the adjudicator's lifetime. PRE only: the proposed
    // text is the artefact a retry re-presents byte-for-byte, where the POST diff is already
    // landed and matches nothing an agent will propose again.
    //
    // TWO separate bounds, because they cover different things. The hash check only catches
    // a re-proposal of the SAME change, which is the rare case - an agent iterating produces
    // different content every time and would otherwise spawn one adjudicator per edit. The
    // in-flight cap is what actually bounds the cost. Being over the cap loses a verdict,
    // never an edit, and the next hook invocation tries again.
    if (pre && opts.blockOnCritical && contentHash && !adjudicationExistsFor(cwd, envName, contentHash)) {
      if (inFlightAdjudications(cwd, envName) < MAX_CONCURRENT_ADJUDICATIONS) {
        spawnDeferredAdjudication({ identity, context, cwd, contentHash }, envName);
      }
    }

    // Drop decisions the sibling hook already showed the agent moments ago.
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
 * Launch the deferred adjudicator (ALI-570). The payload travels by FILE, never argv:
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
 * could-not-check must stay fail-open (ALI-414), and a deny may only rest on an adjudicated
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
    // an unadjudicated row: could-not-check stays fail-open (ALI-414), and unlike a clean
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

/**
 * What a deferred verdict is stored and matched under (ALI-570): the PROPOSED CHANGE, and
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

// Called from runAdvisory's deferred-verdict short-circuit (ALI-570): the hook itself is
// retrieval-only, so the ONLY thing that reaches these blocking branches is a verdict the
// background adjudicator recorded for this exact change.
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
