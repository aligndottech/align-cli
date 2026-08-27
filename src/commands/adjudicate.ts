/**
 * `align adjudicate <event-id>` - answer a check that ran and declined to rule (ALI-710).
 *
 * The other half of a strict CI gate. `fail-on: conflict-or-unknown` fails an incomplete
 * result, which is right, but a NON-VERDICT never becomes complete on its own: the judge
 * reached the change, found a relationship it cannot turn into a pass or a conflict, and
 * every re-run returns that same answer. Without this the only ways past it are a repo-admin
 * bypass, which leaves no record, or weakening the policy for everyone.
 *
 * The gateway matches the answer to a digest of the content it was sent, so re-running the
 * check on the same change finds it, and answering something you were never shown is not
 * available.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveEnv } from '../lib/resolve-env.js';

const VERDICTS = ['accepted', 'conflicting'] as const;
type Verdict = (typeof VERDICTS)[number];

function isVerdict(v: string): v is Verdict {
  return (VERDICTS as readonly string[]).includes(v);
}

export function registerAdjudicateCommand(program: Command): void {
  program
    .command('adjudicate <event-id>')
    .description(
      'Answer an alignment check that reached the judge and declined to rule. The event id is printed by the failing check.',
    )
    .requiredOption(
      '--verdict <verdict>',
      `Your answer: accepted (the change may proceed) or conflicting (it really does conflict)`,
    )
    .option('--note <note>', 'Why - recorded alongside your answer')
    .option('--env <env>', 'Environment')
    .action(async (eventId: string, opts: { verdict: string; note?: string; env?: EnvName }) => {
      if (!isVerdict(opts.verdict)) {
        console.error(
          chalk.red(`\n  --verdict must be one of: ${VERDICTS.join(', ')}\n`),
        );
        process.exit(1);
      }

      const client = createGatewayClient(createConfigStore().getEnvironment(resolveEnv(opts.env)));
      const spinner = ora('Recording your answer...').start();
      try {
        const res = await client.adjudicateCheck(eventId, opts.verdict, opts.note);
        spinner.stop();

        if (res.alreadyAdjudicated) {
          // Not an error: the first answer stands by design, so someone got here first and
          // the caller's intent is already served. Saying whose answer it is matters more
          // than saying the write did not happen.
          console.log(
            chalk.yellow(
              `\n  Already answered by ${res.adjudicatedBy} as "${res.verdict}". The first answer stands.\n`,
            ),
          );
          return;
        }

        console.log(chalk.green(`\n  Recorded: ${res.verdict}.\n`));
        if (res.verdict === 'accepted') {
          console.log(
            chalk.dim('  Re-run the check on the same change and it will pass on this answer.\n'),
          );
        } else {
          // A 'conflicting' answer is a real act with a real consequence, so it does not get
          // a message implying anything is now unblocked.
          console.log(chalk.dim('  The check stays red on this change, which is the point.\n'));
        }
      } catch (err) {
        spinner.fail(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
