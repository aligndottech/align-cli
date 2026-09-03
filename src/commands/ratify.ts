/**
 * `align ratify <id>` - the human act (ALI-831).
 *
 * An agent-made decision enters the graph as a CLAIM: `decider_kind = 'agent'`, nothing in
 * `ratified_at`. Ratifying is a person saying "this governs". The whole design turns on that
 * act being a human's, so this command refuses any caller that is not a person at a
 * terminal: a hook and a pipe both arrive with a stdin that is not a TTY, and so does an
 * agent's shell tool. There is deliberately no `--yes` to get past it - a bypass flag is
 * exactly what an agent would pass. The cloud route makes the same refusal as a 403 to a
 * service account; this is that fail direction, locally.
 *
 * Two flags, two acts (Tom, 2026-09-03): confirm is "this was said" and is the session
 * importer's to write; ratify is "this governs" and is only ever written here.
 *
 * The TTY check is a strong signal, not a cryptographic guarantee: it says stdin is a real
 * terminal device, which is what a hook, a pipe, and an ordinary agent-shell tool lack.
 * A caller that deliberately allocates a pty to fake one is not stopped by this alone -
 * the same honesty this repo already applies to the cloud's fail-open defaults
 * (verification.md: "for any control, ask which way it fails when unconfigured").
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveLocalIdentity } from '../lib/git.js';
import { resolveEnv } from '../lib/resolve-env.js';

export function registerRatifyCommand(program: Command): void {
  program
    .command('ratify <id>')
    .description('Stand behind an agent-made decision as a human: mark it as governing, not just said')
    .option('--env <env>', 'Environment')
    .action(async (id: string, opts: { env?: EnvName }) => {
      // stdin, not stdout: a person may pipe the OUTPUT somewhere and still be a person.
      // What a hook, a pipe and an agent shell all lack is a terminal on the input side.
      if (!process.stdin.isTTY) {
        console.error(chalk.red('\n  align ratify is a human act, and this was not run from a terminal.'));
        console.error(chalk.red('  A hook, a pipe, or an agent shell cannot ratify - an agent must not stand behind its own premise.'));
        console.error(chalk.dim(`\n  Open a terminal and run: align ratify ${id}\n`));
        process.exit(1);
        return;
      }

      const config = createConfigStore();
      const envName = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const client = createGatewayClient(config.getEnvironment(envName));
      const ratifiedBy = await resolveLocalIdentity();
      const spinner = ora('Recording your ratification...').start();
      try {
        const res = await client.ratifyDecision(id, { ratifiedBy });
        spinner.stop();
        if (res.alreadyRatified) {
          // Not an error: the first ratification stands by design.
          const when = res.ratifiedAt ? ` on ${res.ratifiedAt.slice(0, 10)}` : '';
          console.log(chalk.yellow(`\n  Already ratified by ${res.ratifiedBy ?? 'a human'}${when}. The first ratification stands.\n`));
          return;
        }
        console.log(chalk.green(`\n  Ratified by ${res.ratifiedBy ?? ratifiedBy}.`));
        if (envName === 'local') {
          console.log(chalk.dim(`  It now reads as governing in .align/decisions.md and to the local MCP server.`));
          console.log(chalk.dim(`  To share it: align push ${id} --env prod\n`));
        } else {
          console.log('');
        }
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
