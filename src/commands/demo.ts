import type { Command } from 'commander';
import chalk from 'chalk';
import { createConfigStore } from '../lib/config.js';
import { createLocalDb } from '../lib/local-db.js';
import { getLocalDbPath } from '../lib/local-mode.js';
import { getEmbedding } from '../lib/local-embeddings.js';
import { DEMO_DECISIONS, seedDemoGraph } from '../lib/demo-seed.js';

export function registerDemoCommand(program: Command): void {
  const demo = program
    .command('demo')
    .description('Load a small sample decision graph to try Align (safe to reset)');

  demo
    .command('seed')
    .description('Populate the local graph with a curated cross-tool sample (Slack + GitHub)')
    .option('-f, --force', 'Replace an existing non-empty local graph')
    .action(async (opts: { force?: boolean }) => {
      const dbPath = getLocalDbPath();
      const db = createLocalDb(dbPath);

      const existing = db.getStats().decisions;
      if (existing > 0 && !opts.force) {
        db.close();
        console.error(
          chalk.yellow(
            `Your local graph already has ${existing} decision(s). ` +
            `Re-run with ${chalk.cyan('--force')} to replace them with the sample, ` +
            `or ${chalk.cyan('align demo reset')} to wipe first.`,
          ),
        );
        process.exitCode = 1;
        return;
      }
      if (existing > 0) db.dropAll();

      const { spinner } = await import('@clack/prompts');
      const s = spinner();
      s.start('Seeding sample graph (embedding on-device, may download the model on first run)...');
      await seedDemoGraph(db, getEmbedding);
      const stats = db.getStats();
      s.stop('Sample graph ready');
      db.close();

      // Point local mode at this file so `align mcp --env local` serves the sample.
      createConfigStore().setLocalMode(dbPath);

      console.log(
        `\n${chalk.green(`Seeded ${stats.decisions} sample decisions`)} across Slack + GitHub ` +
        `(${chalk.dim(dbPath)}).\n\n` +
        `  Try it:   ${chalk.cyan('align ask "why do we use gRPC for service-to-service calls?"')}\n` +
        `  Wire IDE: ${chalk.cyan('align mcp --setup')}  then ask your agent the same question.\n\n` +
        `  ${chalk.bold('Conflict beat')} (agent proposes an async event bus) needs a relationship\n` +
        `  classifier: a running Ollama (e.g. ${chalk.cyan('ollama pull llama3.2')}) or a cloud key\n` +
        `  (${chalk.dim('ANTHROPIC_API_KEY / OPENAI_API_KEY')}). Without one, checks show "aligned".\n\n` +
        `  Reset anytime: ${chalk.cyan('align demo reset')}\n`,
      );
    });

  demo
    .command('reset')
    .description('Wipe the local graph (removes the sample and anything else in it)')
    .action(() => {
      const db = createLocalDb(getLocalDbPath());
      db.dropAll();
      db.close();
      console.log(`Local graph wiped. Run ${chalk.cyan('align demo seed')} to reload the sample.`);
    });

  // Keep the top-level `demo` command from erroring with no subcommand.
  demo.action(() => {
    console.log(
      `Sample decision graph (${DEMO_DECISIONS.length} decisions across Slack + GitHub).\n` +
      `  ${chalk.cyan('align demo seed')}   load the sample\n` +
      `  ${chalk.cyan('align demo reset')}  wipe the graph`,
    );
  });
}
