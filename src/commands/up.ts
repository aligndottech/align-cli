/**
 * `align up`: bring this repo's decisions up to date and write the file the agent reads, in one command.
 *
 * It is the steps a person would otherwise run by hand, in order, each as align itself so it behaves and
 * reports exactly as it does alone: read the repo's commits, read its docs, refresh any connected source,
 * then write `.align/decisions.md`. Nothing here talks to an agent or needs MCP: the file is the interface.
 * When every decision in it comes from the repo, `context sync` writes a normal file to commit.
 */
import type { Command } from 'commander';
import { execa } from 'execa';
import { backfillChildCommand } from '../lib/backfill-state.js';

export const UP_STEPS: Array<{ argv: string[]; what: string; env: boolean }> = [
  { argv: ['connect', 'git', '--approve'], what: "reading the repo's commits", env: true },
  { argv: ['connect', 'docs', '--approve'], what: "reading the repo's docs", env: true },
  // sync always reads the local graph, and takes no --env.
  { argv: ['sync'], what: 'refreshing connected sources', env: false },
  { argv: ['context', 'sync'], what: 'writing .align/decisions.md', env: true },
];

export async function runUp(o: { env?: string; limit?: string; out?: string }, d: { run(argv: string[]): Promise<number>; out(line: string): void }): Promise<number> {
  for (const step of UP_STEPS) {
    const argv = step.env && o.env ? [...step.argv, '--env', o.env] : [...step.argv];
    // Only the step that writes the file takes the file's options.
    if (step.argv[0] === 'context') {
      if (o.limit) argv.push('--limit', o.limit);
      if (o.out) argv.push('--out', o.out);
    }
    const code = await d.run(argv);
    if (code !== 0) {
      d.out(`align up: ${step.what} failed (exit ${code}). Nothing after it ran.`);
      return code;
    }
  }
  return 0;
}

export function registerUpCommand(program: Command): void {
  program
    .command('up')
    .description("Bring this repo's decisions up to date and write .align/decisions.md (commits, docs, connected sources)")
    .option('--env <env>', 'Environment')
    .option('--limit <n>', 'Max decisions in the file (default 30)')
    .option('--out <file>', 'Write to this markdown file in the repo, e.g. DECISIONS.md (only when every decision comes from this repo)')
    .action(async (opts: { env?: string; limit?: string; out?: string }) => {
      const code = await runUp(opts, {
        run: async (argv) => {
          const { command, args } = backfillChildCommand(argv);
          const r = await execa(command, args, { stdio: 'inherit', reject: false });
          return r.exitCode ?? 1;
        },
        out: (line) => console.error(line),
      });
      if (code !== 0) process.exitCode = code;
    });
}
