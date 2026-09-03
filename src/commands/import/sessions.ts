/**
 * `align import sessions` (ALI-808) - reads local coding-agent session transcripts
 * (Claude Code, pi, Codex CLI, opencode; gemini-cli and cursor detect files but cannot yet
 * parse them - see fixtures/sessions/README.md), finds decision-shaped moments in them
 * (today: an answered Claude Code AskUserQuestion - Pass A), and reviews each one with a
 * human before it enters the graph.
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
import { type ConfirmEachItem, runConfirmEachImport } from '../../lib/personal-import.js';
import { resolveImportEnv } from '../../lib/resolve-env.js';
import { detectAgents } from '../../lib/sessions/registry.js';
import { extractStructuredDecisions, type SessionDecisionCandidate } from '../../lib/sessions/extract-structured.js';
import { buildSessionSourceUrl } from '../../lib/sessions/source-url.js';
import { SessionFormatUnverifiedError } from '../../lib/sessions/types.js';

/** Mirrors ratify.ts's resolveRatifier exactly (git identity, then the OS user) but is not
 *  imported from there - see the PR description for why this one small duplication was
 *  chosen over reaching into a command file ALI-808 does not own. */
async function resolveConfirmer(): Promise<string> {
  return (await getGitIdentity()) ?? os.userInfo().username;
}

class SessionCandidateItem implements ConfirmEachItem {
  constructor(readonly candidate: SessionDecisionCandidate) {}
  render(): string {
    const c = this.candidate;
    return `${chalk.cyan(`[${c.agent}]`)} ${c.question}\n  ${chalk.dim('->')} ${c.chosenLabel}`;
  }
}

function bySortableTimestamp(a: SessionDecisionCandidate, b: SessionDecisionCandidate): number {
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

      const candidates: SessionDecisionCandidate[] = [];
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
          candidates.push(...extractStructuredDecisions(session));
        }
      }

      if (candidates.length === 0) {
        console.log(chalk.dim('\nNo decision-shaped moments found in your local session data.\n'));
        return;
      }

      candidates.sort(bySortableTimestamp);
      const limit = parseInt(opts.limit, 10);
      const toReview = candidates.slice(0, limit);
      const truncatedNote = candidates.length > toReview.length
        ? ` (showing the first ${toReview.length} of ${candidates.length} - raise with --limit)`
        : '';
      console.log(chalk.bold(`\nFound ${candidates.length} decision-shaped moment${candidates.length === 1 ? '' : 's'} to review${truncatedNote}.\n`));
      console.log(chalk.dim('Each one enters the graph as an agent claim (unratified) - review it, `align ratify` later stands behind it as a human.\n'));

      const client = createLocalGatewayClient(env.localDbPath);
      const confirmedBy = await resolveConfirmer();
      try {
        const items = toReview.map(c => new SessionCandidateItem(c));
        const result = await runConfirmEachImport(items, async (item) => {
          const c = item.candidate;
          return client.confirmSessionDecision(
            {
              source_url: buildSessionSourceUrl(c.agent, c.sessionId, c.messageId),
              raw_text: `${c.question}\n\nChosen: ${c.chosenLabel}`,
              title: c.question,
              ...(c.timestamp ? { created_at: c.timestamp } : {}),
            },
            confirmedBy,
          );
        }, { label: 'agent session decisions' });

        console.log('');
        if (result.imported > 0) {
          console.log(chalk.green(`Imported ${result.imported} agent-decided claim${result.imported === 1 ? '' : 's'} (unratified).`));
          console.log(chalk.dim('Review them: align decisions list --unratified'));
          console.log(chalk.dim('Stand behind one: align ratify <id>\n'));
        }
        if (result.skipped > 0) console.log(chalk.dim(`Skipped ${result.skipped}.`));
        if (result.remaining > 0) console.log(chalk.dim(`${result.remaining} not reviewed.`));
      } finally {
        client.close();
      }
    });
}
