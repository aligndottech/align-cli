import type { Command } from 'commander';
import ora from 'ora';
import { resolveEnv } from '../lib/resolve-env.js';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { fetchValueRollup, renderValueReadout, type ValueRollupClient } from '../lib/value-rollup.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show what your decision graph has done for you (value readout)')
    .option('--env <env>', 'Environment')
    .action(async (opts: { env?: EnvName }) => {
      const client = createGatewayClient(createConfigStore().getEnvironment(resolveEnv(opts.env)));
      const spinner = ora('Reading your decision graph...').start();
      try {
        const rollup = await fetchValueRollup(client as unknown as ValueRollupClient);
        spinner.stop();
        console.log(`\n${  renderValueReadout(rollup, { mode: 'cloud' })  }\n`);
      } catch (err) {
        spinner.stop();
        throw err;
      }
    });
}
