import type { Command } from 'commander';
import ora from 'ora';
import { resolveEnv } from '../lib/resolve-env.js';
import { createConfigStore, type EnvName } from '../lib/config.js';
import { readValueRollup } from '../lib/read-value-rollup.js';
import { renderValueReadout } from '../lib/value-rollup.js';

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

      // The local read is a SQLite file and needs no spinner; the cloud read is five requests.
      // Which graph is read, and how, lives in readValueRollup - shared with bare `align`'s
      // second-run card (ALI-950) so the two never print different numbers for one graph.
      const spinner = env.mode === 'local-embedded' ? null : ora('Reading your decision graph...').start();
      try {
        const { mode, rollup } = await readValueRollup(config, envName);
        spinner?.stop();
        console.log(`\n${renderValueReadout(rollup, { mode })}\n`);
      } catch (err) {
        spinner?.stop();
        throw err;
      }
    });
}
