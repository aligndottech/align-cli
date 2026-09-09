/**
 * ALI-938: `align invite <email>` - the teammate-request action the bottom-up thesis
 * depends on. A solo dev adopts the free CLI, the agent gets smarter, "this would be
 * amazing if my whole team's decisions were in here" - and this is the command that
 * turns that thought into a real invite instead of a dead end.
 *
 * Three outcomes, decided from `whoami()` alone (no new gateway endpoint needed to
 * classify the caller):
 *  - a personal-email tenant (gmail.com, icloud.com, ...) has nobody to invite - its
 *    tenant is a single-person workspace by construction (provisioning.ts). Explain
 *    that a work email lands them in their company's shared graph instead.
 *  - a work-domain tenant member who is not org_admin cannot create an invite (the
 *    gateway 403s it) - tell them to ask their admin, rather than spending a round
 *    trip proving what the role already says.
 *  - a work-domain org_admin: the real path. POST /admin/invites via
 *    gateway-client.ts's createInvite, print the link.
 *
 * Deliberately NOT behind `preferLocalEmbedded`: inviting a teammate only means
 * anything against a real cloud tenant, so this resolves the same way `login` and
 * `whoami` do - the configured default cloud env, never redirected to a no-account
 * local graph.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { recordFunnelStage } from '../lib/usage-telemetry.js';
import { isPersonalEmailDomain } from '../lib/personal-email-domains.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerInviteCommand(program: Command): void {
  program
    .command('invite <email>')
    .description('Invite a teammate to your shared Align decision graph')
    .option('--env <env>', 'Environment')
    .action(async (email: string, opts: { env?: EnvName }) => {
      if (!EMAIL_RE.test(email)) {
        console.log(chalk.red(`\n  "${email}" doesn't look like an email address.\n`));
        process.exit(1);
        return;
      }

      const config = createConfigStore();
      const envName = resolveEnv(opts.env);
      const env = config.getEnvironment(envName);

      if (env.mode === 'local-embedded') {
        console.log(chalk.yellow(
          `\n  align invite needs a cloud account - a local graph has nobody to invite ${email} into.`,
        ));
        console.log(chalk.dim(`  Run: align login --env preview   (or --env prod)\n`));
        process.exit(1);
        return;
      }
      if (!env.authToken && env.mode !== 'demo') {
        console.log(chalk.yellow(`\n  Not logged in to ${envName}. Run: align login --env ${envName}\n`));
        process.exit(1);
        return;
      }

      // ALI-938: fired for every genuine attempt that gets past the login gate, whether or
      // not the invite is actually sent - a member blocked by the org_admin check is still
      // demand for shared context. Fired without await (same discipline as why.ts's
      // first_useful_decision): telemetry must never delay or fail the command it rides on.
      void recordFunnelStage(env, 'teammate_requested', 'invite');

      const client = createGatewayClient(env);
      const spinner = ora('Checking your account...').start();
      try {
        const me = await client.whoami();
        spinner.stop();

        if (isPersonalEmailDomain(me.user.email)) {
          console.log(chalk.yellow(
            `\n  You're on a personal graph tied to ${me.user.email}, not a company one - there's no team here yet to invite ${email} into.`,
          ));
          console.log(chalk.dim('  A work email lands you in your company\'s shared graph automatically.'));
          console.log(chalk.dim(`  If a teammate already has Align set up there, ask them to run: align invite ${me.user.email}\n`));
          return;
        }

        if (me.user.role !== 'org_admin') {
          console.log(chalk.yellow(`\n  You're a member of ${me.tenant.name}, not an admin, so you can't send invites directly.`));
          console.log(chalk.dim(`  Ask your org's admin to run: align invite ${email}\n`));
          return;
        }

        const inviteSpinner = ora(`Inviting ${email}...`).start();
        const result = await client.createInvite(email);
        inviteSpinner.stop();
        console.log(chalk.green(`\n  Invite sent. Share this link with ${email}:`));
        console.log(chalk.dim(`  ${result.inviteUrl}\n`));
      } catch (err) {
        spinner.stop();
        console.log(chalk.red(`\n  ${(err as Error).message}\n`));
        process.exit(1);
      }
    });
}
