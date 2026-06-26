import { resolveEnv } from '../lib/resolve-env.js';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { synthesiseLocally } from '../lib/local-llm.js';
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
            for (const d of results.results.slice(0, 5)) {
              const statusLabel = d.status && d.status !== 'active' ? chalk.yellow(` [${d.status}]`) : '';
              // Who to talk to (ALI-118) + when (ALI-118 timestamps).
              const who = d.author?.name ? chalk.cyan(` ← ${d.author.name}`) : '';
              const when = formatWhen(d.created_at);
              const whenLabel = when ? chalk.dim(` · ${when}`) : '';
              console.log(chalk.dim(`    - ${d.title} (${d.id})`) + statusLabel + who + whenLabel);
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
          console.log(chalk.dim(`  id: ${d.id}`) + statusLabel + (when ? chalk.dim(`  ·  ${when}`) : ''));
          // Who to talk to (ALI-118).
          if (d.author?.name) console.log(chalk.cyan(`  talk to: ${d.author.name}`));
          console.log('');
        }

        // We only reach the list for a non-file query when synthesis was
        // unavailable - nudge the user toward a conversational answer.
        if (!filePath) {
          console.log(chalk.dim('  Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) for a conversational answer.'));
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
