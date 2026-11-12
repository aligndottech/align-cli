import type { Command } from 'commander';
import { runDemo } from '../lib/demo/run.js';

export function registerDemoCommand(program: Command): void {
  program
    .command('demo')
    .description('See the edit hook catch a decision in a throwaway repo (no account, no AI key, nothing touches your files)')
    .option('--keep', 'Keep the temp folder instead of deleting it when the demo ends')
    .action(async (opts: { keep?: boolean }) => {
      process.exitCode = await runDemo({ keep: opts.keep === true });
    });
}
