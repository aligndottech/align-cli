import type { Command } from 'commander';
import ora from 'ora';
import { resolveEnv } from '../lib/resolve-env.js';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { createGatewayClient } from '../lib/gateway-client.js';
import { createLocalDb } from '../lib/local-db.js';
import { getLocalDbPath } from '../lib/local-mode.js';
import { fetchValueRollup, localValueRollup, renderValueReadout, type ValueRollupClient } from '../lib/value-rollup.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show what your decision graph has done for you (value readout)')
    .option('--env <env>', 'Environment')
    .action(async (opts: { env?: EnvName }) => {
      // preferLocalEmbedded: a no-account local user must read the local graph. Without it
      // their five cloud requests all 401, settle() swallows each one, and status prints an
      // all-zero readout - a silent wrong answer (ALI-505).
      const config = createConfigStore();
      const envName = resolveEnv(opts.env, { preferLocalEmbedded: true });
      const env = config.getEnvironment(envName);

      if (env.mode === 'local-embedded') {
        // Same readout `align local status` gives: the honest offline subset. Reuse rate and
        // health need the cloud graph, and renderValueReadout's local mode says so.
        const db = createLocalDb(env.localDbPath ?? getLocalDbPath());
        // ALI-796: a connector counts as connected once local mode holds a saved token for
        // it - the same check `align local forget` uses to tell "removed" from "nothing saved".
        const isConnected = (id: string) => config.getConnectorFields(envName, id) !== null;
        const rollup = localValueRollup(db, isConnected);
        db.close();
        console.log(`\n${renderValueReadout(rollup, { mode: 'local' })}\n`);
        return;
      }

      const client = createGatewayClient(env);
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
