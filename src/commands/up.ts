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

export const UP_STEPS: Array<{ argv: string[]; what: string; env: boolean; optional?: boolean }> = [
  { argv: ['connect', 'git', '--approve'], what: "reading the repo's commits", env: true },
  { argv: ['connect', 'docs', '--approve'], what: "reading the repo's docs", env: true },
  // sync always reads the LOCAL graph and takes no --env. It refreshes sources outside the repo (a chat, a ticket), so
  // an expired token there must not stop the file being written from the repo's own commits and docs.
  { argv: ['sync'], what: 'refreshing connected sources', env: false, optional: true },
  { argv: ['context', 'sync'], what: 'writing .align/decisions.md', env: true },
];

export async function runUp(o: { env?: string }, d: { run(argv: string[]): Promise<number>; out(line: string): void }): Promise<number> {
  for (const step of UP_STEPS) {
    if (!step.env && o.env && o.env !== 'local') {
      d.out(`align up: ${step.what} skipped: it refreshes the local graph, and --env ${o.env} names another.`);
      continue;
    }
    const code = await d.run(step.env && o.env ? [...step.argv, '--env', o.env] : step.argv);
    if (code !== 0 && step.optional) {
      d.out(`align up: ${step.what} failed (exit ${code}); carried on, since the repo's own decisions do not depend on it.`);
      continue;
    }
    if (code !== 0) {
      d.out(`align up: ${step.what} failed (exit ${code}). Nothing after it ran.`);
      return code;
    }
  }
  return 0;
}

/**
 * How a step runs: align itself as a child, keeping the loader flags the parent ran under (`--import tsx` in a source
 * checkout), which backfillChildCommand leaves out. An installed build has none, so its argument shape is unchanged.
 */
export function upChildCommand(
  argv: string[],
  o: { execArgv?: string[]; execPath?: string; argv1?: string; dist?: 'npm' | 'binary' } = {},
): { command: string; args: string[] } {
  const c = backfillChildCommand(argv, { ...(o.dist ? { dist: o.dist } : {}), ...(o.execPath ? { execPath: o.execPath } : {}), ...('argv1' in o ? { argv1: o.argv1 } : {}) });
  const execArgv = o.execArgv ?? process.execArgv;
  // A compiled binary is run with the argv alone; only a node script (args = [script, ...argv]) takes loader flags.
  return execArgv.length && c.args.length === argv.length + 1 ? { command: c.command, args: [...execArgv, ...c.args] } : c;
}

export function registerUpCommand(program: Command): void {
  program
    .command('up')
    .description("Bring this repo's decisions up to date and write .align/decisions.md (commits, docs, connected sources)")
    .option('--env <env>', 'Environment')
    .action(async (opts: { env?: string }) => {
      const code = await runUp(opts, {
        run: async (argv) => {
          const { command, args } = upChildCommand(argv);
          const r = await execa(command, args, { stdio: 'inherit', reject: false });
          return r.exitCode ?? 1;
        },
        out: (line) => console.error(line),
      });
      if (code !== 0) process.exitCode = code;
    });
}
