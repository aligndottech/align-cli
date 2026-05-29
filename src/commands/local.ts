import type { Command } from 'commander';
import chalk from 'chalk';
import { createConfigStore } from '../lib/config.js';
import { createLocalDb } from '../lib/local-db.js';
import { getLocalDbPath, initLocalMode } from '../lib/local-mode.js';

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
      outro(
        `${chalk.green('Your local Align graph is ready.')}\n` +
        `  Graph stored at: ${chalk.dim(dbPath)}\n` +
        `  No account needed. Data stays on your machine.\n\n` +
        `  Run ${chalk.cyan('align mcp --setup')} to wire up your IDE, or\n` +
        `  run ${chalk.cyan('ALIGN_ENV=local align mcp')} to start the MCP server.`,
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
      const stats = db.getStats();
      db.close();
      console.log(`Decisions:  ${stats.decisions}`);
      console.log(`Embeddings: ${stats.embeddings}`);
      console.log(`Conflicts:  ${stats.conflicts}`);
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
      }
      config.clearLocalMode();
      console.log('Local graph wiped. Run `align local start` to reinitialize.');
    });
}
