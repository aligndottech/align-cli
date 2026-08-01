import type { Command } from 'commander';

/**
 * Read a subcommand's options including any inherited from its parent.
 *
 * The parent `import` command declares `--env` (and `--approve`) alongside every
 * subcommand that also declares them. Commander resolves that name collision in
 * the parent's favour, so `align import git --approve --env local` leaves the
 * subcommand's own `opts` with neither: `--approve` never skips the confirm and
 * `--env local` never routes to the local graph.
 *
 * `optsWithGlobals()` merges the ancestors' parsed values back in, with the
 * subcommand's own values winning, so its defaults are preserved.
 */
export function subcommandOpts<T>(cmd: Command): T {
  return cmd.optsWithGlobals() as T;
}
