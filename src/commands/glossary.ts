/**
 * `align glossary review` - read the PROPOSED aliases in your org glossary (ALI-1578, ALI-1883).
 *
 * The gateway keeps a per-org alias glossary ("payments-svc" means "payments"). Anything may
 * PROPOSE an entry (a person, an agent, the bootstrap from repos and teams), and every proposal
 * starts `proposed`. Only a confirmed alias is read to match a query, so confirming is the one act
 * that changes behaviour, and it is a person's: the gateway accepts it only from a signed-in web
 * session, which this CLI's login is not.
 *
 * So this command is read-only on purpose. It lists what is waiting, can ask the gateway to
 * propose more (`--bootstrap`, which writes proposals only), and points at the web app. It has no
 * call that confirms or rejects, so there is nothing here to work around that rule.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient, type GlossaryAlias } from '../lib/gateway-client.js';
import { resolveAppUrl } from '../lib/env-resolver.js';
import { resolveEnv } from '../lib/resolve-env.js';

interface ReviewOptions {
  env?: EnvName;
  bootstrap?: boolean;
  list?: boolean;
}

const describeAlias = (a: GlossaryAlias): string => `"${a.alias}" means "${a.canonical}"`;

function sourceNote(a: GlossaryAlias): string {
  if (a.source === 'bootstrap') return 'proposed from your repos and teams';
  if (a.source === 'agent') return 'proposed by an agent';
  if (a.source === 'human') return 'proposed by a person';
  return 'proposer unknown';
}

export function registerGlossaryCommand(program: Command): void {
  const glossary = program
    .command('glossary')
    .description('Your org alias glossary: product names, service names and codenames, confirmed by a person (cloud)');

  glossary
    .command('review')
    .description('List the proposed aliases waiting for a decision. Confirm or reject them in the web app (cloud)')
    .option('--env <env>', 'Environment')
    .option('--bootstrap', 'First propose aliases from your repos, teams and spaces (writes proposals only)')
    .option('--list', 'Print the proposed aliases and stop (this is what the command does without it)')
    .action(async (opts: ReviewOptions) => {
      const env = createConfigStore().getEnvironment(resolveEnv(opts.env));
      const client = createGatewayClient(env);
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
        console.error(chalk.red(`\n  ${(err as Error).message}\n`));
        process.exit(1);
        return;
      }

      if (aliases.length === 0) {
        console.log(chalk.green('\n  Nothing to review: no alias is waiting for a decision.\n'));
        return;
      }
      console.log(chalk.bold(`\n  ${aliases.length} proposed alias${aliases.length === 1 ? '' : 'es'}\n`));
      for (const a of aliases) console.log(`  ${describeAlias(a)}  ${chalk.dim(`(${sourceNote(a)})`)}`);
      if (omitted > 0) console.log(chalk.yellow(`\n  ${omitted} more not shown. Settle these, then run this again.`));
      console.log(`\n  Confirm or reject them in the web app: ${resolveAppUrl(env).replace(/\/+$/, '')}/settings/glossary\n`);
    });
}
