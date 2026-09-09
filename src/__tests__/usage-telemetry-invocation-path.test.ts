/**
 * ALI-949: bare `align` recorded nothing. The postAction hook in src/index.ts built the
 * command path by walking `actionCommand.parent`, and the ROOT command (`program.action(
 * runDefaultAction)`, ALI-773) has no parent - so the path was '' and the funnel's
 * "activated" stage could not see the primary first-run path at all.
 *
 * invocationCommandPath is the extracted walk, exercised through real Commander objects so
 * the root case is pinned against the library's actual parent chain rather than a fake.
 */
import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { invocationCommandPath } from '../lib/usage-telemetry.js';

/** Parse argv and return the actionCommand the postAction hook would have been handed. */
async function actionCommandFor(argv: string[]): Promise<Command> {
  const program = new Command().name('align');
  let seen: Command | undefined;
  program.hook('postAction', (_this, actionCommand) => {
    seen = actionCommand;
  });
  program.command('ask <query>').action(() => {});
  const local = program.command('local');
  local.command('ask <query>').action(() => {});
  const imp = program.command('import');
  imp.command('git').action(() => {});
  program.action(() => {});
  await program.parseAsync(['node', 'align', ...argv]);
  if (!seen) throw new Error('postAction hook never fired');
  return seen;
}

describe('invocationCommandPath', () => {
  it('a top-level command is its own name', async () => {
    expect(invocationCommandPath(await actionCommandFor(['ask', 'why']))).toBe('ask');
  });

  it('a nested command is the full path, so the offline `local` group stays excludable', async () => {
    expect(invocationCommandPath(await actionCommandFor(['local', 'ask', 'why']))).toBe('local ask');
  });

  it('a subcommand group keeps its second word (activation-by-source)', async () => {
    expect(invocationCommandPath(await actionCommandFor(['import', 'git']))).toBe('import git');
  });

  // The root command has no parent, and the old walk produced '' for it.
  it('bare `align` (the root action) is named after the program, never the empty string', async () => {
    expect(invocationCommandPath(await actionCommandFor([]))).toBe('align');
  });
});
