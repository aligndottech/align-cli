import type { Command } from 'commander';
import chalk from 'chalk';
import { createConfigStore } from '../lib/config.js';
import { getTelemetryStatus } from '../lib/usage-telemetry.js';

/**
 * ALI-618: `align telemetry on|off|status`. `on`/`off` set the LOCAL consent decision - the
 * cloud opt-out default is controlled by ALIGN_TELEMETRY, not by this command, and `status`
 * says which model applies (see usage-telemetry.ts's getTelemetryStatus).
 */
export function registerTelemetryCommand(program: Command): void {
  const telemetry = program
    .command('telemetry')
    .description('Manage anonymous usage telemetry consent for local-only mode');

  telemetry
    .command('on')
    .description('Opt in to anonymous usage pings in local-only mode')
    .action(() => {
      createConfigStore().setTelemetryConsent('granted');
      console.log(chalk.green('Telemetry on.'));
      console.log(chalk.dim('Anonymous command names will be sent in local-only mode. No code, no decisions, ever.'));
    });

  telemetry
    .command('off')
    .description('Opt out of anonymous usage pings in local-only mode')
    .action(() => {
      createConfigStore().setTelemetryConsent('declined');
      console.log(chalk.green('Telemetry off.'));
    });

  telemetry
    .command('status')
    .description('Show the effective telemetry state and why')
    .action(async () => {
      const config = createConfigStore();
      const { resolveEnv } = await import('../lib/resolve-env.js');
      const env = config.getEnvironment(resolveEnv(undefined));
      const status = getTelemetryStatus(env, config.getTelemetryConsent());
      console.log(status.reason);
    });
}
