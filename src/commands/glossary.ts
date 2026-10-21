/**
 * `align glossary review` - a person confirms or rejects each PROPOSED alias (ALI-1578).
 *
 * The gateway keeps a per-org alias glossary ("payments-svc" means "payments"). Anything may
 * PROPOSE an entry (a person, an agent, the bootstrap from repos and teams), and every proposal
 * starts `proposed`. Only a confirmed alias is ever read to match a query, so the confirmation is
 * the one act that changes behaviour, and it has to be a human's.
 *
 * Two controls keep it that way, one here and one on the gateway:
 *  - this command refuses a caller whose stdin is not a terminal (a hook, a pipe, an agent shell),
 *    and posts a confirm or reject only for the item the person answered. There is no `--yes`
 *    and no default answer: skipping, quitting and cancelling post nothing. The same stance as
 *    `align ratify`.
 *  - the gateway's confirm and reject routes refuse anything but an interactive login. The CLI's
 *    own login token is not one, so a confirm from here can come back 403
 *    `confirmation_requires_human`. That is reported as what it is (the gateway's rule), never
 *    retried and never worked around.
 */
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient, GatewayError, type GlossaryAlias } from '../lib/gateway-client.js';
import { resolveEnv } from '../lib/resolve-env.js';

interface ReviewOptions {
  env?: EnvName;
  bootstrap?: boolean;
  list?: boolean;
}

type Answer = 'confirm' | 'reject' | 'skip' | 'quit';

const describeAlias = (a: GlossaryAlias): string => `"${a.alias}" means "${a.canonical}"`;

function sourceNote(a: GlossaryAlias): string {
  if (a.source === 'bootstrap') return 'proposed from your repos and teams';
  if (a.source === 'agent') return 'proposed by an agent';
  if (a.source === 'human') return 'proposed by a person';
  return 'proposer unknown';
}

function printList(aliases: GlossaryAlias[], omitted: number): void {
  console.log(chalk.bold(`\n  ${aliases.length} proposed alias${aliases.length === 1 ? '' : 'es'}\n`));
  for (const a of aliases) console.log(`  ${describeAlias(a)}  ${chalk.dim(`(${sourceNote(a)})`)}`);
  if (omitted > 0) console.log(chalk.yellow(`\n  ${omitted} more not shown. Settle these, then run this again.`));
  console.log('');
}

function refusedByGateway(e: unknown, code: string): boolean {
  return e instanceof GatewayError && e.message.includes(code);
}

function stopWith(message: string, hint?: string): never {
  console.error(chalk.red(`\n  ${message}`));
  if (hint) console.error(chalk.dim(`  ${hint}`));
  console.error('');
  process.exit(1);
}

export function registerGlossaryCommand(program: Command): void {
  const glossary = program
    .command('glossary')
    .description('Your org alias glossary: product names, service names and codenames, confirmed by a person (cloud)');

  glossary
    .command('review')
    .description('Walk the proposed aliases and confirm or reject each one. Nothing is confirmed without your answer (cloud)')
    .option('--env <env>', 'Environment')
    .option('--bootstrap', 'First propose aliases from your repos, teams and spaces (writes proposals only)')
    .option('--list', 'Print the proposed aliases and stop. Works without a terminal, changes nothing')
    .action(async (opts: ReviewOptions) => {
      // stdin, not stdout: a person may pipe the OUTPUT somewhere and still be a person.
      // --list is a read, so it is the one path a script may take.
      if (!opts.list && !process.stdin.isTTY) {
        console.error(chalk.red('\n  align glossary review is a human act, and this was not run from a terminal.'));
        console.error(chalk.red('  A hook, a pipe, or an agent shell cannot confirm an alias - an agent must not approve its own vocabulary.'));
        console.error(chalk.dim('\n  Open a terminal and run: align glossary review'));
        console.error(chalk.dim('  To only read the proposals: align glossary review --list\n'));
        process.exit(1);
        return;
      }

      const client = createGatewayClient(createConfigStore().getEnvironment(resolveEnv(opts.env)));
      const spinner = ora('Fetching proposed aliases...').start();
      let aliases: GlossaryAlias[];
      let omitted: number;
      try {
        if (opts.bootstrap) {
          const report = await client.bootstrapGlossary();
          spinner.stop();
          console.log(chalk.dim(`\n  Bootstrap: ${report.proposed} new proposal${report.proposed === 1 ? '' : 's'} from ${report.candidates} candidates (${report.alreadyKnown} already known).`));
          if (report.overProposalCap > 0) console.log(chalk.yellow(`  ${report.overProposalCap} candidates not tried this run. Run it again after reviewing.`));
          spinner.start('Fetching proposed aliases...');
        }
        ({ aliases, omitted } = await client.listGlossaryAliases('proposed'));
        spinner.stop();
      } catch (err) {
        spinner.stop();
        stopWith((err as Error).message);
      }

      if (aliases.length === 0) {
        console.log(chalk.green('\n  Nothing to review: no alias is waiting for a decision.\n'));
        return;
      }
      if (opts.list) {
        printList(aliases, omitted);
        return;
      }

      console.log(chalk.bold(`\n  ${aliases.length} proposed alias${aliases.length === 1 ? '' : 'es'} to review`));
      console.log(chalk.dim('  A confirmed alias widens how your graph matches a name. Skip anything you are unsure of.\n'));

      let confirmed = 0;
      let rejected = 0;
      let skipped = 0;
      for (const a of aliases) {
        const answer = await p.select<Answer>({
          message: `${describeAlias(a)}  (${sourceNote(a)})`,
          options: [
            { value: 'confirm', label: 'Confirm', hint: 'use this when matching' },
            { value: 'reject', label: 'Reject', hint: 'never propose it again' },
            { value: 'skip', label: 'Skip for now' },
            { value: 'quit', label: 'Stop here' },
          ],
          initialValue: 'skip',
        });
        if (p.isCancel(answer) || answer === 'quit') break;
        if (answer === 'skip') {
          skipped += 1;
          continue;
        }
        try {
          if (answer === 'confirm') {
            await client.confirmGlossaryAlias(a.id);
            confirmed += 1;
          } else {
            await client.rejectGlossaryAlias(a.id);
            rejected += 1;
          }
        } catch (err) {
          if (refusedByGateway(err, 'confirmation_requires_human')) {
            stopWith(
              `The gateway refused: ${(err as Error).message}`,
              'Confirming an alias needs a signed-in web session, which this CLI login is not. Confirm it in the web app instead. Nothing further was sent.',
            );
          }
          if (refusedByGateway(err, 'insufficient_permission')) {
            stopWith(`The gateway refused: ${(err as Error).message}`, 'Your role cannot confirm or reject aliases. Nothing further was sent.');
          }
          if (err instanceof GatewayError && err.statusCode === 409) {
            const why = refusedByGateway(err, 'alias_would_not_apply')
              ? 'it would not apply (it conflicts with an alias already confirmed)'
              : (err as Error).message;
            console.log(chalk.yellow(`  ${describeAlias(a)} could not be ${answer === 'confirm' ? 'confirmed' : 'rejected'}: ${why}`));
            skipped += 1;
            continue;
          }
          stopWith((err as Error).message);
        }
      }
      console.log(chalk.green(`\n  ${confirmed} confirmed, ${rejected} rejected, ${skipped} skipped.`));
      if (omitted > 0) console.log(chalk.yellow(`  ${omitted} more not shown. Run this again to see them.`));
      console.log('');
    });
}
