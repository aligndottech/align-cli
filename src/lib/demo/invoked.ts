import type { Command } from 'commander';

/** The command word on the command line: the first argument that is not an option. Undefined for bare `align`. */
export function invokedCommandName(argv: readonly string[]): string | undefined {
  return argv.slice(2).find((a) => !a.startsWith('-'));
}

/** The top-level command a (sub)command sits under: `align foo demo` is `foo`, never `demo`. */
export function topLevelCommandName(cmd: Command): string {
  let top = cmd;
  while (top.parent?.parent) top = top.parent;
  return top.name();
}
