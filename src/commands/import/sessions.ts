/**
 * `align import sessions` (ALI-808/809) - reads local coding-agent session transcripts
 * (Claude Code, pi, Codex CLI, opencode; gemini-cli and cursor detect files but cannot yet
 * parse them - see fixtures/sessions/README.md), finds decision-shaped moments in them, and
 * reviews each one with a human before it enters the graph. The passes, by name rather than
 * by count, so adding one does not silently contradict this sentence:
 *
 *   Pass A (extract-structured.ts): an answered Claude Code AskUserQuestion. Structured, so
 *   every field (question, options, chosen label) is exact - fires only for Claude Code.
 *
 *   Pass B (extract-freetext.ts + confirm-freetext.ts, ALI-809): a human turn that redirects
 *   or settles on an approach in prose ("let's use X instead"), heuristically found and then
 *   confirmed by an LLM before it may reach this list - "heuristic proposes, LLM adjudicates,
 *   only adjudicated results assert" (align decision ALI-409, applied to candidates instead of
 *   graph edges). This is what makes the command produce anything for the five agents with no
 *   structured signal (ALI-808's own survey found none). Rendered with a visibly lower-weight
 *   tag (agent, "free-text", confidence %) than a Pass A record, per the ticket's own
 *   requirement - a low-confidence prose guess must never look as authoritative as a rejected-
 *   alternatives-and-rationale structured one.
 *
 *   Pass C (memory-files.ts, ALI-810): a Claude Code auto-memory file
 *   (`~/.claude/projects/<project>/memory/*.md`), typed `project` or `feedback` in its own
 *   frontmatter. Already curated by the harness - one fact per file - so it needs no
 *   heuristic and no LLM stage, only the same confirm-each review. Read independently of
 *   any adapter, because memory files are deliberately excluded from the transcript
 *   retention sweep and so outlive the sessions that produced them.
 *
 * Local-only by construction: `decider_kind`/`confirmed_by`/`confirmed_at` are local-graph
 * columns (ALI-831), so this refuses any environment that is not the local embedded graph
 * rather than silently doing nothing useful. Per Tom's ruling (2026-09-03): local by
 * default, per-item push after ratify (`align push`, once `align ratify` stands behind
 * one), never bulk - this command writes claims, not decisions.
 */
import type { Command } from 'commander';
import os from 'node:os';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../../lib/config.js';
import { getGitIdentity } from '../../lib/git.js';
import { IMPORT_LIMITS } from '../../lib/import-defaults.js';
import { createLocalGatewayClient } from '../../lib/local-gateway-client.js';
import { type ConfirmEachItem, runConfirmEachImport, runWithConcurrency } from '../../lib/personal-import.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { detectAgents } from '../../lib/sessions/registry.js';
import { extractStructuredDecisions, type SessionDecisionCandidate } from '../../lib/sessions/extract-structured.js';
import { findFreeTextCandidates, type RawFreeTextCandidate } from '../../lib/sessions/extract-freetext.js';
import {
  type ConfirmedFreeTextDecision,
  type ConfirmFailureReason,
  confirmFreeTextCandidate,
  describeConfirmFailure,
} from '../../lib/sessions/confirm-freetext.js';
import { buildMemorySourceUrl, buildSessionSourceUrl } from '../../lib/sessions/source-url.js';
import { renderImportSummary } from '../../lib/sessions/import-summary.js';
import { recordFunnelStage } from '../../lib/usage-telemetry.js';
import {
  extractMemoryDecisions,
  locateMemoryFiles,
  type MemoryDecisionCandidate,
} from '../../lib/sessions/memory-files.js';
import { SessionFormatUnverifiedError } from '../../lib/sessions/types.js';
import type { LlmFailure } from '../../lib/local-llm.js';

/** Same as personal-import.ts's BATCH_CONCURRENCY - see the confirmation loop below for why a
 *  larger number would not actually help against a single local Ollama instance. */
const FREE_TEXT_CONFIRM_CONCURRENCY = 3;

/** Mirrors ratify.ts's resolveRatifier exactly (git identity, then the OS user) but is not
 *  imported from there - see the PR description for why this one small duplication was
 *  chosen over reaching into a command file ALI-808 does not own. */
async function resolveConfirmer(): Promise<string> {
  return (await getGitIdentity()) ?? os.userInfo().username;
}

/** What every reviewable session candidate must produce to be written - Pass A and Pass B
 *  share this write shape even though they render and confirm completely differently. */
interface SessionWriteBody {
  source_url: string;
  raw_text: string;
  title: string;
  created_at?: string;
}

interface SessionReviewItem extends ConfirmEachItem {
  toWrite(): SessionWriteBody;
}

class SessionCandidateItem implements SessionReviewItem {
  constructor(readonly candidate: SessionDecisionCandidate) {}
  render(): string {
    const c = this.candidate;
    return `${chalk.cyan(`[${c.agent}]`)} ${c.question}\n  ${chalk.dim('->')} ${c.chosenLabel}`;
  }
  toWrite(): SessionWriteBody {
    const c = this.candidate;
    return {
      source_url: buildSessionSourceUrl(c.agent, c.sessionId, c.messageId),
      raw_text: `${c.question}\n\nChosen: ${c.chosenLabel}`,
      title: c.question,
      ...(c.timestamp ? { created_at: c.timestamp } : {}),
    };
  }
}

/** Pass B (ALI-809): a heuristic-proposed, LLM-confirmed free-text redirect. Rendered with a
 *  visibly different tag and its confidence score so a low-confidence prose guess never carries
 *  the same visual weight as a rejected-alternatives-and-rationale structured record (the
 *  ticket's own requirement - see extract-freetext.ts and confirm-freetext.ts for the two
 *  stages that produce this). */
class FreeTextCandidateItem implements SessionReviewItem {
  constructor(readonly decision: ConfirmedFreeTextDecision) {}
  render(): string {
    const d = this.decision;
    const pct = Math.round(d.confidence * 100);
    const said = d.humanText.length > 140 ? `${d.humanText.slice(0, 140)}...` : d.humanText;
    return `${chalk.yellow(`[${d.agent} - free-text - ${pct}%]`)} ${d.title}\n  ${chalk.dim('said:')} "${said}"`;
  }
  toWrite(): SessionWriteBody {
    const d = this.decision;
    return {
      source_url: buildSessionSourceUrl(d.agent, d.sessionId, d.messageId),
      raw_text: d.humanText,
      title: d.title,
      ...(d.timestamp ? { created_at: d.timestamp } : {}),
    };
  }
}

/**
 * Pass C (ALI-810): a Claude Code auto-memory file. No LLM stage, unlike Pass B - these are
 * already curated by the harness itself (one fact per file, typed in frontmatter), so there
 * is no heuristic to adjudicate. It still goes through the same confirm-each review, because
 * a memory file is a personal note, not something to bulk-import.
 *
 * Tagged distinctly for the same reason Pass B is: a reader must be able to tell where a
 * candidate came from, and "Claude wrote this note to itself" is a different provenance from
 * "a human answered a question".
 */
class MemoryCandidateItem implements SessionReviewItem {
  constructor(readonly candidate: MemoryDecisionCandidate) {}
  render(): string {
    const c = this.candidate;
    const first = c.body.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() ?? '';
    const preview = first.length > 140 ? `${first.slice(0, 140)}...` : first;
    return `${chalk.magenta(`[claude-code - memory - ${c.type}]`)} ${c.title}\n  ${chalk.dim('note:')} "${preview}"`;
  }
  toWrite(): SessionWriteBody {
    const c = this.candidate;
    return {
      source_url: buildMemorySourceUrl(c.memoryDir, c.filePath),
      raw_text: c.body,
      title: c.title,
      ...(c.timestamp ? { created_at: c.timestamp } : {}),
    };
  }
}

type PendingCandidate =
  | { kind: 'structured'; timestamp: string | null; item: SessionDecisionCandidate }
  | { kind: 'freetext'; timestamp: string | null; item: RawFreeTextCandidate }
  | { kind: 'memory'; timestamp: string | null; item: MemoryDecisionCandidate };

/**
 * ALI-835: the agent a run's ping is attributed to - the one that contributed the most parsed
 * session files. Several agents can be detected on one machine, the ping carries one name, and
 * an invented "mixed" would be a value the gateway's closed AGENT_VALUES enum does not have.
 * Ties resolve to the first inserted, which is registry order, so the same machine reports the
 * same name run to run rather than flipping on a Map-iteration coincidence.
 */
function dominantAgent(filesByAgent: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [agent, count] of filesByAgent) {
    if (count > bestCount) { best = agent; bestCount = count; }
  }
  return best;
}

function bySortableTimestamp(a: { timestamp: string | null }, b: { timestamp: string | null }): number {
  // Undated candidates sort last rather than colliding at epoch-0, which would otherwise
  // interleave them arbitrarily with real early timestamps.
  const ta = a.timestamp ?? '9999';
  const tb = b.timestamp ?? '9999';
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

export function registerImportSessionsCommand(importCmd: Command): void {
  importCmd
    .command('sessions')
    .description('Review decision-shaped moments from local coding-agent sessions (Claude Code, pi, Codex CLI, opencode) one by one')
    .option('--limit <n>', 'Max candidates to review', String(IMPORT_LIMITS.sessions))
    .option('--env <env>', 'Environment (must be local)')
    .action(async (opts: { limit: string; env?: EnvName }) => {
      const config = createConfigStore();
      const envName = resolveImportEnv(opts.env);
      const env = config.getEnvironment(envName);

      if (env.mode !== 'local-embedded' || !env.localDbPath) {
        console.error(chalk.red('\n  align import sessions only works against your local graph.'));
        console.error(chalk.dim('  decider_kind, confirmed_by and confirmed_at are local-only columns today - run `align setup --local` first, or add --env local.\n'));
        process.exit(1);
        return;
      }

      const cwd = process.cwd();
      const detected = detectAgents(cwd);
      if (detected.length === 0) {
        console.log(chalk.dim('\nNo local session data found for any known agent in this project.\n'));
        return;
      }

      const structured: SessionDecisionCandidate[] = [];
      const freeText: RawFreeTextCandidate[] = [];
      // ALI-835: files actually parsed, not files located - an adapter with no verified fixture
      // is skipped below, and counting its files would report work that never happened.
      let sessionsScanned = 0;
      // The agent whose data this run is about. Several can be detected; the ping carries one
      // name, so it carries the one with the most files rather than an invented "mixed".
      const filesByAgent = new Map<string, number>();
      for (const { adapter, files } of detected) {
        if (!adapter.fixtureVerified) {
          console.log(chalk.yellow(`\n  Found ${adapter.agent} session data, but this reader cannot parse it yet (no verified fixture - see src/__tests__/fixtures/sessions/README.md). Skipping.`));
          continue;
        }
        for (const file of files) {
          let session;
          try {
            session = adapter.parseSession(file);
          } catch (err) {
            if (err instanceof SessionFormatUnverifiedError) {
              console.log(chalk.yellow(`\n  ${err.message}`));
              break;
            }
            throw err;
          }
          if (!session) continue;
          sessionsScanned++;
          filesByAgent.set(adapter.agent, (filesByAgent.get(adapter.agent) ?? 0) + 1);
          structured.push(...extractStructuredDecisions(session));
          freeText.push(...findFreeTextCandidates(session));
        }
      }

      // Pass C (ALI-810): the harness's own auto-memory, which is a separate source from any
      // session transcript - it is read whether or not an adapter found session files, because
      // memory survives the transcript retention sweep that deletes them.
      const memory = extractMemoryDecisions(locateMemoryFiles(cwd));

      const agent = dominantAgent(filesByAgent);
      const candidatesFound = structured.length + freeText.length + memory.length;

      // ALI-835: the two scan-time stages. Emitted before the review loop, so a user who
      // abandons the review still reports what was scanned and found - which is the drop-off
      // the funnel exists to show. Fire-and-forget: telemetry never delays or fails a command.
      if (agent) {
        void recordFunnelStage(env, 'sessions_scanned', 'import sessions', { count: sessionsScanned, agent });
        void recordFunnelStage(env, 'candidates_found', 'import sessions', { count: candidatesFound, agent });
      }

      if (candidatesFound === 0) {
        // Honest at zero: a scan that found nothing still reports how much it read, so "nothing
        // here" is distinguishable from "nothing ran".
        console.log(chalk.dim(`\n${renderImportSummary({ sessionsScanned, candidatesFound: 0, candidatesConfirmed: 0, ratified: 0 })}\n`));
        return;
      }

      // Merge BEFORE the limit so --limit bounds the whole review queue, not just Pass A -
      // then confirm only the free-text candidates that actually fall inside the window,
      // so a low --limit also bounds how many LLM calls this command makes.
      const pending: PendingCandidate[] = [
        ...structured.map(c => ({ kind: 'structured' as const, timestamp: c.timestamp, item: c })),
        ...freeText.map(c => ({ kind: 'freetext' as const, timestamp: c.timestamp, item: c })),
        ...memory.map(c => ({ kind: 'memory' as const, timestamp: c.timestamp, item: c })),
      ];
      pending.sort(bySortableTimestamp);
      const limit = parseInt(opts.limit, 10);
      const toReview = pending.slice(0, limit);
      const totalFound = pending.length;
      const truncatedNote = totalFound > toReview.length
        ? ` (showing the first ${toReview.length} of ${totalFound} - raise with --limit)`
        : '';
      console.log(chalk.bold(`\nFound ${totalFound} decision-shaped moment${totalFound === 1 ? '' : 's'} to review${truncatedNote}.\n`));
      console.log(chalk.dim('Each one enters the graph as an agent claim (unratified) - review it, `align ratify` later stands behind it as a human.\n'));

      // Pass B: only an LLM-adjudicated result may reach the review list (align decision
      // ALI-409's "heuristic proposes, LLM adjudicates, only adjudicated results assert").
      // Bounded concurrency, not one-at-a-time: each call is a full LLM round-trip, and
      // FREE_TEXT_CONFIRM_CONCURRENCY matches the ingest batch concurrency in
      // personal-import.ts (3) rather than a larger number, since a local Ollama model is a
      // single shared resource that concurrent requests would just queue behind anyway.
      const freeTextPositions = toReview
        .map((p, i) => (p.kind === 'freetext' ? i : -1))
        .filter(i => i !== -1);
      const confirmResults = await runWithConcurrency(
        freeTextPositions.map(i => () => confirmFreeTextCandidate((toReview[i] as { item: RawFreeTextCandidate }).item)),
        FREE_TEXT_CONFIRM_CONCURRENCY,
      );

      const failures = new Map<ConfirmFailureReason, { count: number; failure?: LlmFailure }>();
      const recordFailure = (reason: ConfirmFailureReason, failure?: LlmFailure): void => {
        const bucket = failures.get(reason) ?? { count: 0, failure };
        bucket.count++;
        failures.set(reason, bucket);
      };

      const items: SessionReviewItem[] = [];
      let confirmIdx = 0;
      for (const p of toReview) {
        if (p.kind === 'structured') {
          items.push(new SessionCandidateItem(p.item));
          continue;
        }
        if (p.kind === 'memory') {
          items.push(new MemoryCandidateItem(p.item));
          continue;
        }
        const settled = confirmResults[confirmIdx++];
        if (settled.status === 'rejected') {
          recordFailure('confirm_error');
          continue;
        }
        const outcome = settled.value;
        if (!outcome.ok) { recordFailure(outcome.reason, outcome.failure); continue; }
        if (outcome.decision) items.push(new FreeTextCandidateItem(outcome.decision));
        // outcome.decision === null: the model looked and said the heuristic misfired -
        // nothing was actually decided here, so it is dropped silently, same as a rejected
        // AskUserQuestion in extract-structured.ts.
      }

      const reportUnconfirmed = (): void => {
        for (const [reason, { count, failure }] of failures) {
          console.log(chalk.dim(`(${count} free-text candidate${count === 1 ? '' : 's'} not confirmed.${describeConfirmFailure(reason, failure)})`));
        }
      };

      if (items.length === 0) {
        console.log(chalk.dim('\nNothing survived confirmation - candidates were found but none were confirmed as real decisions.\n'));
        reportUnconfirmed();
        return;
      }
      reportUnconfirmed();

      const client = createLocalGatewayClient(env.localDbPath);
      const confirmedBy = await resolveConfirmer();
      try {
        const result = await runConfirmEachImport(items, async (item) => {
          return client.confirmSessionDecision(item.toWrite(), confirmedBy);
        }, { label: 'agent session decisions' });

        console.log('');
        if (result.imported > 0) {
          console.log(chalk.green(`Imported ${result.imported} agent-decided claim${result.imported === 1 ? '' : 's'} (unratified).`));
          console.log(chalk.dim('Review them: align decisions list --unratified'));
          console.log(chalk.dim('Stand behind one: align ratify <id>\n'));
        }
        if (result.skipped > 0) console.log(chalk.dim(`Skipped ${result.skipped}.`));
        if (result.remaining > 0) console.log(chalk.dim(`${result.remaining} not reviewed.`));

        // ALI-835: the line the demo reads aloud, and the stage that measures it - built from
        // one counts object so the printed number and the reported number cannot disagree.
        // `ratified` is 0 by construction here: this command writes claims, and ratifying is a
        // separate human act. That zero is the point of the sentence.
        const counts = {
          sessionsScanned,
          candidatesFound,
          candidatesConfirmed: result.imported,
          ratified: 0,
        };
        console.log('');
        console.log(renderImportSummary(counts));
        if (agent) {
          void recordFunnelStage(env, 'candidates_confirmed', 'import sessions', { count: result.imported, agent });
        }
      } finally {
        client.close();
      }
    });
}
