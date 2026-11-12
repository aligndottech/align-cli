import type { Command } from 'commander';
import { runDemo } from '../lib/demo/run.js';
import { recordDemoRun } from '../lib/usage-telemetry.js';

export function registerDemoCommand(program: Command): void {
  program
    .command('demo')
    .description('See the edit hook catch a decision in a throwaway repo (no account, no AI key, nothing touches your files)')
    .option('--keep', 'Keep the temp folder instead of deleting it when the demo ends')
    .action(async (opts: { keep?: boolean }) => {
      const started = Date.now();
      let code = 1;
      try {
        code = await runDemo({ keep: opts.keep === true });
      } finally {
        // One anonymous run count, after the demo, from this parent process. It reads only the
        // environment and never opens ~/.align (see recordDemoRun), and it cannot throw.
        await recordDemoRun({ success: code === 0, durationMs: Date.now() - started });
      }
      process.exitCode = code;
    });
}
