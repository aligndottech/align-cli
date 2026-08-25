import { resolveEnv } from '../lib/resolve-env.js';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import type { SearchResults } from '../lib/gateway-client.js';
import { citationFor } from '../lib/decision-links.js';
import { getUnvettedOllamaModels, synthesiseLocally, VETTED_OLLAMA_MODELS } from '../lib/local-llm.js';
import { formatWhen } from '../lib/format-date.js';

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
  const cite = d.cite ?? citationFor(d.source_url);
  const ref = cite ? ` (${cite})` : ` (${d.id})`;
  const platform = d.platform ? chalk.magenta(` [${d.platform}]`) : '';
  const statusLabel = d.status && d.status !== 'active' ? chalk.yellow(` [${d.status}]`) : '';
  const who = d.author?.name ? chalk.cyan(` ← ${d.author.name}`) : '';
  const when = formatWhen(d.created_at);
  const whenLabel = when ? chalk.dim(` · ${when}`) : '';
  return chalk.dim(`    - ${d.title}${ref}`) + platform + statusLabel + who + whenLabel;
}

/** The indented link under a source line - where it was DECIDED, clickable. */
function sourceLink(d: SearchHit): string | null {
  return d.source_url ? chalk.dim(`      ${d.source_url}`) : null;
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
    .action(async (query: string, opts: { env?: EnvName; limit: string }) => {
      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(resolveEnv(opts.env, { preferLocalEmbedded: true })));

      // Pass the query through unchanged: the gateway's smart-search strategy
      // selector routes natural-language questions to semantic search. Stripping
      // the question word turned questions into keyword phrases that matched
      // nothing (ALI-105). File paths were already passed through verbatim.
      const filePath = isFilePath(query);
      const searchQuery = query;
      const spinner = ora('').start();

      try {
        const results = await client.searchDecisions(searchQuery, parseInt(opts.limit, 10));
        spinner.stop();

        if (!results.results.length) {
          console.log('');
          if (filePath) {
            console.log(chalk.dim(`  No decisions found for ${query}.`));
            console.log(chalk.dim('  Import from more sources to build context:'));
          } else {
            console.log(chalk.dim('  No decisions found. Build your graph first:'));
            console.log(chalk.dim('    align import git'));
          }
          console.log(chalk.dim('    align import linear   # or jira, slack, notion, confluence'));
          console.log('');
          return;
        }

        // Conversational synthesis for natural-language questions (not file paths).
        // Uses the user's own AI provider (configured key / env var / local Ollama)
        // via synthesiseLocally; returns null when none is available, in which case
        // we fall through to the ranked decision list below.
        if (!filePath) {
          const answer = await synthesiseLocally(
            query,
            results.results.map((d) => ({ id: d.id, title: d.title, summary: d.summary ?? '' })),
          );
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
          const count = results.count;
          console.log(chalk.bold(`\n  ${count} decision${count === 1 ? '' : 's'} in your graph\n`));
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
          const when = formatWhen(d.created_at);
          // Cite first (human-quotable, align-stack#1442), derived from
          // source_url when the wire omits it - the SAME derivation as
          // sourceLine, or the two paths drift (Copilot, #124). The id ALWAYS
          // prints, never replaced by the cite: `align decisions show <id>`
          // consumes the id, and a cite is not an id (the autofix's ref-swap
          // on this line would have broken that flow exactly when a cite is
          // derivable, which is most of the time).
          const cite = d.cite ?? citationFor(d.source_url);
          const citeLabel = cite ? chalk.dim(` (${cite})`) : '';
          const platformLabel = d.platform ? chalk.magenta(` [${d.platform}]`) : '';
          console.log(chalk.dim(`  id: ${d.id}`) + citeLabel + platformLabel + statusLabel + (when ? chalk.dim(`  ·  ${when}`) : ''));
          if (d.source_url) console.log(chalk.dim(`  ${d.source_url}`));
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
          const unvetted = getUnvettedOllamaModels();
          if (unvetted) {
            console.log(chalk.dim('  No answer written: Ollama is running, but none of these'));
            console.log(chalk.dim('  models are vetted for decision synthesis.'));
            for (const m of unvetted) console.log(chalk.dim(`    - ${m}`));
            console.log(chalk.dim(`  Pull one:     ollama pull ${VETTED_OLLAMA_MODELS[0]}`));
            console.log(chalk.dim('  Or name one:  ALIGN_OLLAMA_MODEL=<model>'));
          } else {
            console.log(chalk.dim('  Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) for a conversational answer.'));
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
