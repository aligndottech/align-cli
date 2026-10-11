/**
 * `align invite [email]` points an org admin at Settings > Team invites in the web app.
 *
 * It used to POST /admin/invites with the CLI's api_token (ALI-938). The gateway now refuses that
 * on purpose (requireAdminSurface): an agent's token must not add team members, so invites are
 * created in the browser by a signed-in admin. This command creates nothing and calls no invite
 * route. It prints the page and, for a person at a terminal, opens it with the allowlisted opener
 * (no shell). Inside an agent align launched (ALIGN_WRAPPED), or with no TTY, it only prints.
 *
 * Deliberately NOT behind `preferLocalEmbedded`: a team only exists on a cloud destination, so this
 * resolves the same way `login` and `whoami` do.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { inviteSettingsUrl, resolveInviteAppUrl } from '../lib/invite-settings.js';
import { resolveEnv } from '../lib/resolve-env.js';
import { currentDeliveryEnv, decideDelivery, openSettingsLink } from '../lib/share/delivery.js';
import { visible } from '../lib/share/visible.js';
import { recordFunnelStage } from '../lib/usage-telemetry.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerInviteCommand(program: Command): void {
  program
    .command('invite [email]')
    .description('Open Team invites in the web app, where an org admin creates invite links')
    .option('--env <env>', 'Environment')
    .action(async (email: string | undefined, opts: { env?: EnvName }) => {
      if (email !== undefined && !EMAIL_RE.test(email)) {
        console.log(chalk.red(`\n  "${visible(email)}" doesn't look like an email address.\n`));
        process.exit(1);
        return;
      }

      const envName = resolveEnv(opts.env);
      const env = createConfigStore().getEnvironment(envName);
      if (env.mode === 'local-embedded') {
        console.log(chalk.yellow('\n  align invite needs a cloud account - a local graph has no team to invite anyone into.'));
        console.log(chalk.dim('  Run: align login --env preview   (or --env prod)\n'));
        process.exit(1);
        return;
      }

      // ALI-938: the demand signal survives the move to the browser. Fired without await:
      // telemetry must never delay or fail the command it rides on.
      void recordFunnelStage(env, 'teammate_requested', 'invite');

      const appUrl = await resolveInviteAppUrl(env, async (signal) => (await createGatewayClient(env).shareRequestsConfig(signal))?.appUrl ?? null);
      const url = inviteSettingsUrl(appUrl);
      const who = email ? `a link for ${visible(email)}, and send it to them` : 'a link, and send it to the person joining';
      console.log('\n  Invites are created in the web app, by an org admin.');
      console.log(`  Open Team invites, create ${who}.`);
      console.log(`\n  ${chalk.bold(visible(url))}\n`);

      const de = currentDeliveryEnv();
      if (de.env['ALIGN_WRAPPED'] || !decideDelivery(de, {}).open) return;
      if (!(await openSettingsLink(url, appUrl))) console.log(chalk.dim('  Could not open a browser here. Open the link above yourself.\n'));
    });
}
