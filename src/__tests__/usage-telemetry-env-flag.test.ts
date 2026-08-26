/**
 * Which env the postAction hook reads is a consent decision, so it has to read the flag the
 * user actually typed - including when Commander resolved a name collision in the PARENT's
 * favour. `align import git --env local` leaves the subcommand's own `opts()` with no `env`
 * (align-cli#79), so a plain `.opts()` here would fall back to the default env and report a
 * local command to the cloud - the exact defect this slice exists to close, reintroduced one
 * layer up.
 *
 * Driven with real Commander objects rather than a fake, because the behaviour under test IS
 * Commander's collision resolution: a hand-built double would encode my belief about it.
 */

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { envFlagOf } from '../lib/usage-telemetry.js';

/** The `import` shape from align-cli#79: --env declared on BOTH parent and subcommand. */
function importLikeProgram(): Command {
  const program = new Command();
  program.exitOverride().name('align');
  const parent = program
    .command('import')
    .option('--env <env>', 'environment')
    .action(() => {});
  parent
    .command('git')
    .option('--env <env>', 'environment')
    .action(() => {});
  return program;
}

/** Captures the Command that Commander reports as the acting one, as index.ts's hook does. */
function actingCommandFor(argv: string[]): Command {
  const program = importLikeProgram();
  let acting: Command | null = null;
  program.hook('postAction', (_thisCommand, actionCommand) => {
    acting = actionCommand;
  });
  program.parse(argv, { from: 'user' });
  if (!acting) throw new Error('no command acted - the fixture never reached the hook');
  return acting;
}

describe('envFlagOf', () => {
  it('reads --env when it lands on the subcommand', () => {
    expect(envFlagOf(actingCommandFor(['import', 'git', '--env', 'local']))).toBe('local');
  });

  // The collision case. Commander gives the parent the value, so `.opts()` on the acting
  // command is empty here and only optsWithGlobals() can see it.
  it('reads --env when Commander resolved the collision in the parent\'s favour', () => {
    expect(envFlagOf(actingCommandFor(['import', '--env', 'local', 'git']))).toBe('local');
  });

  // The negative side, so a helper that just returned 'local' could not pass.
  it('returns undefined when no --env was given', () => {
    expect(envFlagOf(actingCommandFor(['import', 'git']))).toBeUndefined();
  });

  it('reads a non-local env too, so the value is passed through rather than special-cased', () => {
    expect(envFlagOf(actingCommandFor(['import', '--env', 'preview', 'git']))).toBe('preview');
  });
});
