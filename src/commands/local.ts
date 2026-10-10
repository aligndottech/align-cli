import { existsSync as fileExists } from 'node:fs';
import type { Command } from 'commander';
import chalk from 'chalk';
import { createConfigStore } from '../lib/config.js';
import { createLocalDb } from '../lib/local-db.js';
import { getLocalDbPath, initLocalMode, LOCAL_DB_SUFFIXES } from '../lib/local-mode.js';
import { localValueRollup, renderValueReadout } from '../lib/value-rollup.js';
import { forgetSourceData } from '../lib/sync/forget.js';
import { isPurgeable, PURGEABLE_SOURCES, purgePreview } from '../lib/sync/purge.js';
import { BACKFILL_SOURCES } from '../lib/mcp-backfill.js';
import { refreshSummary } from '../lib/sync/summary.js';

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
      // ALI-796: same check as `align status` and `align local forget` - connected means
      // local mode holds a saved token for it.
      const isConnected = (id: string) => config.getConnectorFields('local', id) !== null;
      const rollup = localValueRollup(db, isConnected);
      db.close();
      console.log(`\n${  renderValueReadout(rollup, { mode: 'local' })  }\n`);
    });

  // Local mode asks you to mint read-only tokens and then keeps them, so it owes you a way to
  // hand them back. The provider is still the place to revoke - this only forgets our copy.
  local
    .command('forget [connector]')
    .description('Remove saved read-only tokens (all, or one named connector)')
    .option('--purge', 'Also delete the items imported from that connector, except any you ratified, confirmed, captured by hand, acted on or judged. Asks first')
    .option('--yes', 'With --purge: skip the question (needed when there is no terminal)')
    .action(async (connector: string | undefined, opts: { purge?: boolean; yes?: boolean }) => {
      const config = createConfigStore();
      const env = config.getEnvironment('local');
      const dbPath = env.mode === 'local-embedded' ? env.localDbPath : undefined;
      // The launch summary lists connected sources; forgetting one must not leave it there.
      const refresh = (): void => {
        if (dbPath && fileExists(dbPath)) refreshSummary(dbPath, (id) => Boolean(config.getConnectorFields('local', id)?.['token']));
      };
      const refuse = (message: string): void => { console.error(message); process.exitCode = 2; };
      if (opts.purge && (!connector || !isPurgeable(connector))) {
        // A purge across every source in one word, or of a name that is not a connector (cli, git, a typo),
        // is not a thing to do by accident. Nothing is deleted and no token is forgotten.
        refuse(`align local forget: --purge needs the name of a connected source (${PURGEABLE_SOURCES.join(', ')}), for example: align local forget slack --purge`);
        return;
      }
      if (!connector) {
        config.forgetAllConnectors('local');
        for (const id of BACKFILL_SOURCES) forgetSourceData(dbPath, id, { purge: false });
        refresh();
        console.log('Removed every saved read-only token. Setup will ask again next time.');
        return;
      }
      // Distinguish "removed it" from "there was nothing there": silence on a no-op reads as
      // success, and leaves someone believing a credential is gone that was never stored.
      const had = Boolean(config.getConnectorFields('local', connector));
      if (!had && !opts.purge) {
        console.log(`Nothing saved for ${connector}.`);
        return;
      }
      if (opts.purge && dbPath && fileExists(dbPath)) {
        const { deleted, kept } = purgePreview(dbPath, connector);
        if (deleted > 0 && !opts.yes) {
          const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
          if (!interactive) {
            refuse(`align local forget: --purge would delete ${deleted} ${connector} items (keeping ${kept}) and there is no terminal to ask in. Nothing was changed. Pass --yes to go ahead.`);
            return;
          }
          const { confirm } = await import('@clack/prompts');
          if ((await confirm({ message: `Delete ${deleted} ${connector} items nobody has vouched for (keeping ${kept})? A copy is kept in the graph file for recovery.`, initialValue: false })) !== true) {
            console.log('Cancelled. Nothing was changed.');
            return;
          }
        }
      }
      // The graph first, in one transaction; the token only after it succeeded. A failure here leaves both as they were.
      let r;
      try {
        r = forgetSourceData(dbPath, connector, { purge: opts.purge === true });
      } catch (e) {
        console.error(`align local forget: ${(e as Error).message} The saved token was not removed.`);
        process.exitCode = 1;
        return;
      }
      if (had) config.forgetConnector('local', connector);
      refresh();
      console.log(had
        ? `Removed the saved token for ${connector}. Revoke it at the provider too if you are done with it.`
        : `Nothing saved for ${connector}.`);
      if (r.purged) {
        console.log(`Deleted ${r.purged.deleted} ${connector} items nobody had vouched for, and kept ${r.purged.kept} (ratified, confirmed, captured by hand, acted on or judged).`);
      } else if (r.staying > 0) {
        console.log(`${r.staying} ${connector} items stay in your graph. To delete the ones nobody has vouched for: align local forget ${connector} --purge`);
      }
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
        // Remove the DB file and its WAL sidecars for a true wipe. The suffix list is
        // shared with migrateLocalDb rather than repeated here: delete and relocate must
        // agree on what "the graph" is, or one of them leaves half of it behind.
        const { existsSync, rmSync } = await import('node:fs');
        for (const suffix of LOCAL_DB_SUFFIXES) {
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
