import type { Command } from 'commander';
import chalk from 'chalk';
import { createConfigStore } from '../lib/config.js';
import { getTelemetryStatus } from '../lib/usage-telemetry.js';

/**
 * ALI-618: `align telemetry on|off|status`. `on`/`off` set the LOCAL decision - the cloud
 * opt-out default is controlled by ALIGN_TELEMETRY, not by this command - and `status` says
 * which model applies (see usage-telemetry.ts's getTelemetryStatus).
 *
 * ALI-954: `off` stores 'off', which stops BOTH tiers - the usage pings and the two anonymous
 * counts that send by default (install, setup completed). That is a stronger decision than
 * answering No at the consent prompt, which only declines usage, and the message says so.
 */
export function registerTelemetryCommand(program: Command): void {
  const telemetry = program
    .command('telemetry')
    .description('Manage anonymous telemetry in local-only mode (two counts by default, usage only with consent)');

  telemetry
    .command('on')
    .description('Send anonymous usage pings in local-only mode (command names, never content)')
    .action(() => {
      createConfigStore().setTelemetryConsent('granted');
      console.log(chalk.green('Telemetry on.'));
      console.log(chalk.dim('Anonymous command names will be sent in local-only mode. No code, no decisions, ever.'));
    });

  telemetry
    .command('off')
    .description('Stop all telemetry in local-only mode, the two default anonymous counts included')
    .action(() => {
      createConfigStore().setTelemetryConsent('off');
      console.log(chalk.green('Telemetry off.'));
      console.log(chalk.dim('Nothing is sent from this machine - not usage, and not the two anonymous counts (install, setup completed).'));
    });

  telemetry
    .command('status')
    .description('Show the effective telemetry state and why')
    .action(async () => {
      const config = createConfigStore();
      const { resolveEnv } = await import('../lib/resolve-env.js');
      // preferLocalEmbedded: true, or a never-logged-in local-only user (defaultEnv stays
      // 'prod' by design, ALI-87) sees "cloud mode, opt-out default" here regardless of their
      // actual local consent - the exact honesty gap this command exists to close. A
      // fresh-context review caught this.
      const env = config.getEnvironment(resolveEnv(undefined, { preferLocalEmbedded: true }));
      const status = getTelemetryStatus(env, config.getTelemetryConsent());
      console.log(status.reason);
    });
}
