import { resolveEnv } from '../lib/resolve-env.js';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import type { SearchResults } from '../lib/gateway-client.js';
import { localCitationFor } from '../lib/commit-cite.js';
import { ABSTENTION_SENTINEL, isAbstention, type LlmFailure, noProviderHintLines, RECOMMENDED_OLLAMA_PULL, synthesiseDetailed } from '../lib/local-llm.js';
import { recordFunnelStage } from '../lib/usage-telemetry.js';
import { formatWhen } from '../lib/format-date.js';
import { resolveScopeOpts } from '../lib/repo-identity.js';
import { askTrailingLine } from '../lib/connect-prompt.js';

function wrapText(text: string, indent: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && (current + word).length > maxWidth) {
      lines.push(indent + current.trimEnd());
      current = '';
    }
    current += `${word} `;
  }
  if (current.trim()) lines.push(indent + current.trimEnd());
  return lines;
}

function isFilePath(arg: string): boolean {
  return arg.startsWith('./') || arg.startsWith('../') || arg.includes('/') || existsSync(arg);
}

type SearchHit = SearchResults['results'][number];

/**
 * ALI-829: the date a source line shows. The decision's own date when the graph has it
 * (local mode, from the source's timestamp), else the minute it was captured - which is
 * what every line showed before, so a cloud result renders byte-for-byte as it did, and
 * a local row that will never get a date (a docs section, an `align capture`) still reads
 * "today" on the day it was imported. Kept that way on purpose (the plan's open question
 * 6); suppressing it is a visible removal for its own decision. One derivation for the
 * synthesis sources and the list fallback: the two paths had already drifted on the cite
 * once (Copilot, #124).
 */
function decidedWhen(d: SearchHit): string {
  return formatWhen(d.decided_at ?? d.created_at);
}

/**
 * One source line, same fields the MCP surface serves (align-stack#1442 added
 * `cite` so consumers COPY citations instead of composing them - this renderer
 * was the one consumer still printing a raw UUID). The cite replaces the id
 * when present; a decision with no cite (Slack, a meeting) keeps its id, which
 * `align decisions show <id>` needs. Platform is printed on every line: a
 * GitHub PR agreeing with a Slack thread is the cross-tool claim made visible,
 * and it is invisible if every line looks alike (the ALI-586 lesson).
 */
function sourceLine(d: SearchHit): string {
  // Derive the cite when the wire omits it (the prod REST path predates
  // align-stack#1442); the UUID is the last resort, kept only because
  // `align decisions show <id>` consumes it.
  const cite = d.cite ?? localCitationFor(d.source_url);
  const ref = cite ? ` (${cite})` : ` (${d.id})`;
  const platform = d.platform ? chalk.magenta(` [${d.platform}]`) : '';
  const statusLabel = d.status && d.status !== 'active' ? chalk.yellow(` [${d.status}]`) : '';
  const who = d.author?.name ? chalk.cyan(` ← ${d.author.name}`) : '';
  const when = decidedWhen(d);
  const whenLabel = when ? chalk.dim(` · ${when}`) : '';
  return chalk.dim(`    - ${d.title}${ref}`) + platform + statusLabel + who + whenLabel;
}

/** The indented link under a source line - where it was DECIDED, clickable. */
function sourceLink(d: SearchHit): string | null {
  return d.source_url ? chalk.dim(`      ${d.source_url}`) : null;
}

/**
 * The trailing gap line under a source (ALI-796): only when this decision's own refs
 * carry something the graph cannot read yet. Absent for a cloud result, which carries
 * no external_references (the hosted gateway does not store decision_refs yet).
 */
function gapLine(d: SearchHit, isConnected: (connectorId: string) => boolean): string | null {
  if (!d.external_references?.length) return null;
  const line = askTrailingLine(d.external_references, isConnected);
  return line ? chalk.dim(`      ${line}`) : null;
}

/**
 * "5 decisions across github, linear, slack" - printed only when results
 * genuinely span more than one platform. The claim is earned, never decorative:
 * a single-platform result set prints nothing.
 */
function crossToolHeader(results: SearchHit[]): string | null {
  const platforms = [...new Set(results.map((d) => d.platform).filter(Boolean))] as string[];
  if (platforms.length < 2) return null;
  return chalk.dim(`  ${results.length} decisions across ${platforms.join(', ')}`);
}

export function registerAskCommand(program: Command): void {
  program
    .command('ask <query>')
    .description('Ask a question about your decision graph, or pass a file path to find related decisions')
    .option('--env <env>', 'Environment')
    .option('--limit <n>', 'Max answers', '8')
    .option('--repo <name>', 'Scope to one repo - short name, owner/repo, or full identity (local mode only)')
    .option('--all', 'Search every repo, not just the current one (local mode only)')
    .action(async (query: string, opts: { env?: EnvName; limit: string; repo?: string; all?: boolean }) => {
      const config = createConfigStore();
      const envName = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const client = createGatewayClient(config.getEnvironment(envName));
      // ALI-798: undefined means "no opinion" - searchDecisions applies its own default
      // (current repo, or everywhere outside one) exactly as if neither flag were typed.
      const scope = resolveScopeOpts({ repo: opts.repo, all: opts.all }, envName, (m) => console.log(chalk.yellow(`  ${m}`)));
      // ALI-796: same "does local mode hold a saved token" check status.ts and local.ts
      // use. Only ever consulted when a result carries external_references, which today
      // means local mode - a cloud result has none.
      const isConnected = (id: string) => config.getConnectorFields(envName, id) !== null;

      // Pass the query through unchanged: the gateway's smart-search strategy
      // selector routes natural-language questions to semantic search. Stripping
      // the question word turned questions into keyword phrases that matched
      // nothing (ALI-105). File paths were already passed through verbatim.
      const filePath = isFilePath(query);
      const searchQuery = query;
      const spinner = ora('').start();

      try {
        const limit = parseInt(opts.limit, 10);
        let results = await client.searchDecisions(searchQuery, limit, scope);

        // Auto-widen, stage 1: the scoped search found nothing at all. Found live
        // 2026-09-02, the same evening ALI-798's scoping shipped: a cross-repo question
        // asked from the wrong directory had its answer one --all away, and the tool
        // told the user to go and type it. Scoped-first stays (unscoped search blended
        // repos - the bug ALI-798 fixed); widening on a definite miss is the tool doing
        // what its own hint said, before giving up. Never behind an explicit --repo or
        // --all: those are the user constraining the search on purpose.
        const canWiden = !opts.all && !opts.repo;
        let widenedFrom: string | null = null;
        let widenAttempted = false;
        if (!results.results.length && results.scope && canWiden) {
          widenAttempted = true;
          const wholeGraph = await client.searchDecisions(searchQuery, limit, { all: true });
          if (wholeGraph.results.length) {
            widenedFrom = results.scope;
            results = wholeGraph;
          }
        }

        // The spinner's lifetime is the lifetime of the WORK, not of the first search.
        // It used to stop here, so the first synthesis - seconds on a local model - ran
        // against a blank line and read as a hang; stage 2 then restarted it, which was
        // the same gap patched on one path (Copilot on #236). One lifetime: it stops
        // right before the first line of output, in whichever branch prints one, and
        // the catch below fails it if anything in between throws.
        if (!results.results.length) {
          spinner.stop();
          console.log('');
          if (filePath) {
            console.log(chalk.dim(`  No decisions found for ${query}.`));
            console.log(chalk.dim('  Import from more sources to build context:'));
          } else {
            // "Build your graph first" is a claim about the GRAPH, and zero search results
            // are only evidence about the QUERY. ALI-771: a tester was told to build a graph
            // he had just filled, because the question `setup --local`'s outro suggests
            // ("What decisions exist in this codebase?") is ABOUT the graph rather than in
            // it, so it matches nothing semantically and falls under the threshold.
            //
            // Sending someone to re-import a full graph is the worse of the two errors: it
            // reads as the import never having worked. So ask the graph before saying it is
            // empty. One extra call, only on the path that was already returning nothing.
            //
            // ALI-798: `{ all: true }` here is NOT the user's scope choice - it is always
            // unscoped, because the question this check answers is "does the GRAPH have
            // anything in it", not "does this repo". Without it, being inside a repo with
            // zero decisions (while another repo holds hundreds) would answer "no decisions
            // found, build your graph first" - false, and the exact failure this ticket
            // exists to prevent, just moved from retrieval into this diagnostic.
            let graphHasDecisions: boolean | undefined;
            try {
              const some = await client.listDecisions({ limit: 1, all: true });
              graphHasDecisions = Array.isArray(some) && some.length > 0;
            } catch {
              // A cloud token that has expired throws here. Leave the answer unknown and
              // keep the old message: this diagnostic must never make things worse than
              // before it existed.
            }

            if (graphHasDecisions) {
              // Unqualified since ALI-772: `decisions` now prefers the local graph the same
              // way ask, search and import do, so the bare command is the right one to print
              // for every user. It carried `--env ${envName}` while that was not true.
              const listCmd = 'align decisions list';
              if (results.scope && widenAttempted) {
                // The auto-widen already searched everything, so suggesting --all here
                // would promise a re-run that cannot find more than this run just did.
                console.log(chalk.dim(`  Nothing matched "${query}" in ${results.scope} or the rest of your graph.`));
                console.log(chalk.dim('  Try different words, or list what is in there:'));
              } else if (results.scope) {
                // Named because it is the reason nothing matched here, and distinguishes
                // "not in THIS repo" from "not anywhere" (ALI-771's lesson, extended to scope).
                // Reachable only under an explicit --repo, which the widen respects.
                console.log(chalk.dim(`  Nothing matched "${query}" in ${results.scope}.`));
                console.log(chalk.dim('  Try --all to search your whole graph, or list what is in this repo:'));
              } else {
                console.log(chalk.dim(`  Nothing matched "${query}", but your graph is not empty.`));
                console.log(chalk.dim('  Try different words, or list what is in there:'));
              }
              console.log(chalk.dim(`    ${listCmd}`));
              console.log('');
              return;
            }

            console.log(chalk.dim('  No decisions found. Build your graph first:'));
            console.log(chalk.dim('    align import git'));
          }
          console.log(chalk.dim('    align import linear   # or jira, slack, notion, confluence'));
          console.log('');
          return;
        }

        // Conversational synthesis for natural-language questions (not file paths).
        // Uses the user's own AI provider (configured key / env var / local Ollama)
        // via synthesiseDetailed, which reports WHY when there is no answer - carried
        // here so the list fallback below can say it, rather than re-read a module
        // getter that a concurrent call could have cleared.
        //
        // Runs BEFORE the scope header prints: the auto-widen below can change what was
        // actually answered from, and a header naming a scope the answer then abandoned
        // would be wrong the moment it mattered.
        let synthFailure: LlmFailure | undefined;
        let answer: string | null = null;
        if (!filePath) {
          const synth = await synthesiseDetailed(
            query,
            results.results.map((d) => ({ id: d.id, title: d.title, summary: d.summary ?? '' })),
          );
          answer = synth.ok ? synth.text : null;
          if (!synth.ok) synthFailure = synth.failure;

          // Auto-widen, stage 2: the scoped search DID return candidates, and the model
          // read them and abstained (the mandated sentinel makes that detectable). Weak
          // same-repo lookalikes with the real answer in another repo is exactly the
          // live case: retrieval succeeded, the scope was the problem. One extra local
          // search plus one extra model call, only on the path that was about to print
          // "The context does not answer this question" at someone whose graph holds
          // the answer.
          if (answer && isAbstention(answer) && results.scope && canWiden && !widenedFrom) {
            const wholeGraph = await client.searchDecisions(searchQuery, limit, { all: true });
            if (wholeGraph.results.length) {
              const second = await synthesiseDetailed(
                query,
                wholeGraph.results.map((d) => ({ id: d.id, title: d.title, summary: d.summary ?? '' })),
              );
              // Adoption rule, measured against a real model (2026-09-02 probes): on
              // implicit-only context the model can emit the sentinel AND keep talking -
              // the forbidden deny-then-deliver, with the actual answer in the tail. A
              // denial with an informative tail beats a bare sentinel, so:
              //   - a BARE-sentinel scoped answer adopts whatever the widened pass
              //     produced (it cannot be less informative, and even an identical
              //     abstention gains the honest whole-graph framing);
              //   - a scoped answer that already carries a tail only upgrades to a
              //     CLEAN widened answer - swapping one hedged answer for another loses
              //     the accurate scope header for nothing.
              const scopedWasBare = answer.trim() === ABSTENTION_SENTINEL;
              if (second.ok && (scopedWasBare || !isAbstention(second.text))) {
                widenedFrom = results.scope;
                results = wholeGraph;
                answer = second.text;
              }
            }
          }
        }
        spinner.stop();

        // ALI-798: named up front so a reader knows what was searched before reading an
        // answer that might be missing something they know exists in another repo.
        if (widenedFrom) {
          console.log(chalk.dim(`  Nothing in ${widenedFrom} answered - widened to your whole graph`));
        } else if (results.scope) {
          console.log(chalk.dim(`  Answering from ${results.scope} (--all searches every repo)`));
        }

        // ALI-795: a non-empty answer is the funnel's activation moment - emitted here,
        // before rendering branches (the synthesized-answer path returns early). The
        // once-per-install guard lives inside recordFunnelStage. Fired without await
        // (Copilot on #215): a blackholed gateway would otherwise stall the answer by
        // the 2s telemetry timeout; the emitter never throws, and the postAction hook's
        // own awaited send keeps the process alive long enough for this one to land.
        void recordFunnelStage(config.getEnvironment(envName), 'first_useful_decision', 'ask');

        if (!filePath) {
          if (answer) {
            console.log('');
            for (const line of wrapText(answer, '  ', 76)) console.log(line);
            console.log('');
            console.log(chalk.dim('  Sources:'));
            const shown = results.results.slice(0, 5);
            const span = crossToolHeader(shown);
            if (span) {
              console.log(span);
              console.log('');
            }
            for (const d of shown) {
              console.log(sourceLine(d));
              const link = sourceLink(d);
              if (link) console.log(link);
              const gap = gapLine(d, isConnected);
              if (gap) console.log(gap);
            }
            console.log('');
            if (results.count >= 5) {
              console.log(chalk.dim('  Share this graph with your team: https://align.tech/pricing'));
              console.log('');
            }
            return;
          }
        }

        if (filePath) {
          console.log(chalk.bold(`\n  Decisions related to ${query}\n`));
        } else {
          // "matching", not "in your graph": this is the size of the RESULT SET, and
          // `align local status` prints the identical sentence with the real graph size. Two
          // commands using one sentence for two different numbers is how a CI comparison of
          // ask-output against status-output produced two confidently wrong findings.
          const count = results.count;
          console.log(chalk.bold(`\n  ${count} matching decision${count === 1 ? '' : 's'}\n`));
        }

        for (const d of results.results) {
          const score = d.similarity !== undefined
            ? chalk.dim(` (${(d.similarity * 100).toFixed(0)}% match)`)
            : '';
          console.log(chalk.bold(`  ${d.title}`) + score);

          if (d.summary) {
            const summaryLines = wrapText(`"${d.summary}"`, '  ', 74);
            for (const line of summaryLines) {
              console.log(chalk.dim(line));
            }
          }

          const statusLabel = d.status && d.status !== 'active'
            ? chalk.yellow(` [${d.status}]`)
            : '';
          const when = decidedWhen(d);
          // Cite first (human-quotable, align-stack#1442), derived from
          // source_url when the wire omits it - the SAME derivation as
          // sourceLine, or the two paths drift (Copilot, #124). The id ALWAYS
          // prints, never replaced by the cite: `align decisions show <id>`
          // consumes the id, and a cite is not an id (the autofix's ref-swap
          // on this line would have broken that flow exactly when a cite is
          // derivable, which is most of the time).
          const cite = d.cite ?? localCitationFor(d.source_url);
          const citeLabel = cite ? chalk.dim(` (${cite})`) : '';
          const platformLabel = d.platform ? chalk.magenta(` [${d.platform}]`) : '';
          console.log(chalk.dim(`  id: ${d.id}`) + citeLabel + platformLabel + statusLabel + (when ? chalk.dim(`  ·  ${when}`) : ''));
          if (d.source_url) console.log(chalk.dim(`  ${d.source_url}`));
          const gap = gapLine(d, isConnected);
          if (gap) console.log(gap);
          // Who to talk to (ALI-118).
          if (d.author?.name) console.log(chalk.cyan(`  talk to: ${d.author.name}`));
          console.log('');
        }

        // We only reach the list for a non-file query when synthesis was
        // unavailable - say why, and what to do about it.
        if (!filePath) {
          // ALI-420: a running Ollama with no vetted model used to answer anyway, with
          // whatever it listed first. It now declines, so name the models it has rather
          // than telling someone who is already running a provider to configure one.
          const unvetted = synthFailure?.kind === 'unrecognised_local_models' ? synthFailure.models : null;
          const failure = synthFailure?.kind === 'provider_stopped' ? synthFailure : null;
          const unavailable = synthFailure?.kind === 'providers_unavailable' ? synthFailure : null;
          if (unvetted) {
            console.log(chalk.dim('  No answer written: Ollama is running, but none of these'));
            console.log(chalk.dim('  models are recognised for decision synthesis.'));
            for (const m of unvetted) console.log(chalk.dim(`    - ${m}`));
            console.log(chalk.dim(`  Pull one:     ollama pull ${RECOMMENDED_OLLAMA_PULL}`));
            console.log(chalk.dim('  Or name one:  ALIGN_OLLAMA_MODEL=<model>'));
          } else if (failure) {
            // ALI-692: the chain stopped rather than demoting to a weaker model. Name
            // the model that failed - the key hint would be wrong for a user whose
            // provider is configured and answering.
            console.log(chalk.dim(`  No answer written: ${failure.model} (${failure.provider}) returned an`));
            console.log(chalk.dim(`  unusable response (${failure.detail}). A weaker model was not asked in`));
            console.log(chalk.dim('  its place. Retry, or configure a different provider.'));
          } else if (unavailable) {
            // ALI-766: a provider WAS configured and none of them answered. The key nudge
            // below would be the wrong signpost - it reads as "your provider is not
            // supported" to the one user who took the trouble to configure us.
            // "did not answer", not "unreachable": this path also carries availability-class
            // REJECTIONS (401/403/404), where the endpoint answered perfectly well and turned
            // us down. The first wording contradicted this file's own test fixture, which
            // asserts an HTTP 401 case.
            console.log(chalk.dim('  No answer written: no configured provider answered.'));
            for (const t of unavailable.tried) {
              console.log(chalk.dim(`    - ${t.provider}: ${t.detail}`));
            }
            console.log(chalk.dim('  Check the endpoint and key, or configure a different provider.'));
          } else {
            for (const line of noProviderHintLines()) console.log(chalk.dim(`  ${line}`));
          }
          console.log('');
        }

        const count = results.count;
        if (count > 0 && count < 5) {
          console.log(chalk.dim('  Add more sources for richer cross-tool context:'));
          console.log(chalk.dim('    align import linear   # or jira, slack, notion, confluence'));
          console.log('');
        } else if (count >= 5) {
          console.log(chalk.dim('  Share this graph with your team: https://align.tech/pricing'));
          console.log('');
        }
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
