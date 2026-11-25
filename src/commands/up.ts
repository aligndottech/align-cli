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

export async function runUp(o: { env?: string; limit?: string; out?: string; approve?: boolean }, d: { run(argv: string[]): Promise<number>; out(line: string): void }): Promise<number> {
  // Pinned to the local graph unless an environment is named. `--approve` skips the prompt that says where the text goes,
  // so a cloud default must never be reached by leaving --env off: a person who names a cloud env has chosen to send there.
  const env = o.env?.trim() ? o.env : 'local';
  for (const step of UP_STEPS) {
    if (!step.env && env !== 'local') {
      d.out(`align up: ${step.what} skipped: it refreshes the local graph, and --env ${env} names another.`);
      continue;
    }
    const argv = step.env ? [...step.argv, '--env', env] : [...step.argv];
    // Only the step that writes the file takes the file's options.
    if (step.argv[0] === 'context') {
      if (o.limit) argv.push('--limit', o.limit);
      if (o.out) argv.push('--out', o.out);
      if (o.approve) argv.push('--approve');
    }
    const code = await d.run(argv);
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
    .description("Bring this repo's decisions up to date and write .align/decisions.md (commits, docs, connected sources); local unless --env or ALIGN_ENV names another")
    .option('--env <env>', 'Environment')
    .option('--limit <n>', 'Max decisions in the file (default 30)')
    .option('--out <file>', 'Write to this markdown file in the repo, e.g. DECISIONS.md (only when every decision comes from this repo)')
    .option('--approve', 'Allow adding the import line to CLAUDE.md when there is no terminal to ask in')
    .action(async (opts: { env?: string; limit?: string; out?: string; approve?: boolean }) => {
      // ALIGN_ENV is the person's own choice of destination, so it counts as naming one.
      const code = await runUp({ ...opts, env: opts.env ?? process.env['ALIGN_ENV'] }, {
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
