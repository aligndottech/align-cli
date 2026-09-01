import type { Command } from 'commander';
import chalk from 'chalk';
import { createConfigStore } from '../lib/config.js';
import { createLocalDb } from '../lib/local-db.js';
import { getLocalDbPath, initLocalMode } from '../lib/local-mode.js';
import { localValueRollup, renderValueReadout } from '../lib/value-rollup.js';

export function registerLocalCommand(program: Command): void {
  const local = program
    .command('local')
    .description('Manage your local decision graph (no account needed)');

  local
    .command('start')
    .description('Initialize local decision graph')
    .action(async () => {
      const { intro, outro, spinner } = await import('@clack/prompts');
      intro(chalk.bold('Align - Local Mode'));
      const s = spinner();
      s.start('Setting up local graph...');
      const { dbPath } = await initLocalMode();
      s.stop('Local graph ready');

      // initLocalMode used to wire every detected agent's global MCP config from inside
      // itself, without asking. This is the same wiring, asked for (ALI-776).
      const { connectDetectedAgents } = await import('./connect-agents.js');
      await connectDetectedAgents('local');

      outro(
        `${chalk.green('Your local Align graph is ready.')}\n` +
        `  Graph stored at: ${chalk.dim(dbPath)}\n` +
        `  No account needed. Data stays on your machine.\n\n` +
        `  Run ${chalk.cyan('align')} any time to see your graph and what to do next.`,
      );
    });

  local
    .command('status')
    .description('Show local graph statistics')
    .action(() => {
      const config = createConfigStore();
      const env = config.getEnvironment('local');
      if (env.mode !== 'local-embedded') {
        console.log('Local mode is not active. Run `align local start` first.');
        return;
      }
      const db = createLocalDb(env.localDbPath ?? getLocalDbPath());
      const rollup = localValueRollup(db);
      db.close();
      console.log(`\n${  renderValueReadout(rollup, { mode: 'local' })  }\n`);
    });

  // Local mode asks you to mint read-only tokens and then keeps them, so it owes you a way to
  // hand them back. The provider is still the place to revoke - this only forgets our copy.
  local
    .command('forget [connector]')
    .description('Remove saved read-only tokens (all, or one named connector)')
    .action((connector?: string) => {
      const config = createConfigStore();
      if (!connector) {
        config.forgetAllConnectors('local');
        console.log('Removed every saved read-only token. Setup will ask again next time.');
        return;
      }
      // Distinguish "removed it" from "there was nothing there": silence on a no-op reads as
      // success, and leaves someone believing a credential is gone that was never stored.
      if (!config.getConnectorFields('local', connector)) {
        console.log(`Nothing saved for ${connector}.`);
        return;
      }
      config.forgetConnector('local', connector);
      console.log(`Removed the saved token for ${connector}. Revoke it at the provider too if you are done with it.`);
    });

  local
    .command('reset')
    .description('Wipe local graph and reset config')
    .action(async () => {
      const { confirm, intro } = await import('@clack/prompts');
      intro('Reset local graph');
      const ok = await confirm({ message: 'This will delete all local decisions. Continue?' });
      if (!ok) { console.log('Cancelled.'); return; }
      const config = createConfigStore();
      const env = config.getEnvironment('local');
      if (env.localDbPath) {
        const db = createLocalDb(env.localDbPath);
        db.dropAll();
        db.close();
        // Remove the DB file and its WAL sidecars (-wal/-shm) for a true wipe
        const { existsSync, rmSync } = await import('node:fs');
        for (const suffix of ['', '-wal', '-shm']) {
          const f = `${env.localDbPath}${suffix}`;
          if (existsSync(f)) rmSync(f);
        }
      }
      config.clearLocalMode();
      // "Reset config" has to include the saved read-only tokens, or the promise is false in
      // exactly the way the setup copy used to be (ALI-802).
      config.forgetAllConnectors('local');
      console.log('Local graph wiped and saved tokens removed. Run `align local start` to reinitialize.');
    });
}
