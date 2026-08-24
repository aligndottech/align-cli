/**
 * ALI-602: `align context sync` - write the decision graph into the files
 * agents actually read.
 *
 * The renderer and writer live in lib/decisions-context.ts (ALI-196 spike,
 * shipped in #116) and are pinned by their own suites: Align owns
 * `.align/decisions.md` outright, the user's CLAUDE.md gains one import line,
 * appended never spliced (align-cli#116 decided the ownership model - a
 * separate owned file makes augment-never-overwrite structural, so no marker
 * parser exists to get wrong).
 *
 * This module is only the wiring: fetch, map, write, say what happened. It
 * must stay non-interactive - it is exactly the kind of command that ends up
 * in a hook or a CI step, which is where an unguarded prompt hangs (the
 * setup --local lesson, #118).
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'node:fs';
import path from 'node:path';

import { createConfigStore } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { citationFor } from '../lib/decision-links.js';
import {
  ALIGN_CONTEXT_PATH,
  ALIGN_IMPORT_LINE,
  type ContextDecision,
  writeDecisionsContext,
} from '../lib/decisions-context.js';
import type { EnvName } from '../lib/config.js';

export function registerContextCommand(program: Command): void {
  const context = program
    .command('context')
    .description('Manage the decisions file agents read (.align/decisions.md)');

  context
    .command('sync')
    .description(`Write current decisions to ${ALIGN_CONTEXT_PATH} and import it from CLAUDE.md`)
    .option('--env <env>', 'Environment')
    .option('--limit <n>', 'Max decisions to include', '200')
    .action(async (opts: { env: EnvName; limit: string }) => {
      const config = createConfigStore();
      const client = createGatewayClient(config.getEnvironment(resolveEnv(opts.env)));
      const spinner = ora('Fetching decisions...').start();

      // Fetch BEFORE writing anything: a failed fetch must not leave a
      // plausible-looking "no decisions" file behind. An empty file and an
      // unreachable graph are different claims (the ALI-414 rule, new surface).
      let decisions: ContextDecision[];
      try {
        // Active only: the file states what currently governs. Superseded and
        // archived decisions are history, and history is the graph's job.
        const rows = await client.listDecisions({ limit: parseInt(opts.limit, 10), status: 'active' });
        decisions = rows.map((d) => ({
          title: d.title,
          ...(citationFor(d.source_url) ? { cite: citationFor(d.source_url) } : {}),
          ...(d.source_url ? { sourceUrl: d.source_url } : {}),
        }));
      } catch (err) {
        spinner.fail(chalk.red(`Could not fetch decisions: ${(err as Error).message}`));
        process.exit(1);
        return; // unreachable; keeps control flow explicit for the test's exit stub
      }
      spinner.stop();

      const repoRoot = process.cwd();
      const result = await writeDecisionsContext(repoRoot, decisions);

      console.log(`${chalk.green('Wrote')} ${result.contextPath} (${decisions.length} decision${decisions.length === 1 ? '' : 's'})`);

      if (result.importAdded) {
        console.log(`${chalk.green('Added')} ${ALIGN_IMPORT_LINE} import to CLAUDE.md`);
      } else if (fs.existsSync(path.join(repoRoot, 'CLAUDE.md'))) {
        console.log(chalk.dim('CLAUDE.md already imports it.'));
      } else {
        // No CLAUDE.md: we do not invent one (their file, their call). Print
        // the line, or the generated file sits unread by every agent.
        console.log(
          `No CLAUDE.md here - add this line to your agent's context file to load it:\n` +
          `  ${chalk.bold(ALIGN_IMPORT_LINE)}`,
        );
      }
      console.log(chalk.dim('Re-run `align context sync` after new decisions land.'));
    });
}
