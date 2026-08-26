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

/**
 * A non-colliding leaf, which is what MOST commands are: `--env` declared once, on the command
 * that acts. Only the 13 `import` children collide, so a suite built solely from the `import`
 * shape leaves the common case - `align ask --env local`, the string this fix exists for -
 * entirely uncovered, and a parent-only implementation passes it.
 */
function askLikeProgram(): Command {
  const program = new Command();
  program.exitOverride().name('align');
  program
    .command('ask <question>')
    .option('--env <env>', 'environment')
    .action(() => {});
  return program;
}

/** Captures the Command that Commander reports as the acting one, as index.ts's hook does. */
function actingCommandFor(argv: string[], program: Command = importLikeProgram()): Command {
  let acting: Command | null = null;
  program.hook('postAction', (_thisCommand, actionCommand) => {
    acting = actionCommand;
  });
  program.parse(argv, { from: 'user' });
  if (!acting) throw new Error('no command acted - the fixture never reached the hook');
  return acting;
}

describe('envFlagOf', () => {
  // The plain case, on a command whose --env has no parent competing for the name. Named for
  // what the fixture actually builds: on the `import` shape BOTH argument positions are the
  // collision case, because the collision is about the declaration, not the position.
  it('reads --env on a non-colliding leaf command', () => {
    expect(envFlagOf(actingCommandFor(['ask', 'why', '--env', 'local'], askLikeProgram()))).toBe(
      'local',
    );
  });

  // The collision case. Commander gives the parent the value, so `.opts()` on the acting
  // command is empty here and only optsWithGlobals() can see it.
  it('reads --env when Commander resolved the collision in the parent\'s favour', () => {
    expect(envFlagOf(actingCommandFor(['import', '--env', 'local', 'git']))).toBe('local');
  });

  // Same collision, flag after the subcommand: still the parent's, which is the point.
  it('reads --env written after the subcommand, which Commander also gives the parent', () => {
    expect(envFlagOf(actingCommandFor(['import', 'git', '--env', 'local']))).toBe('local');
  });

  // The negative side, so a helper that just returned 'local' could not pass.
  it('returns undefined when no --env was given', () => {
    expect(envFlagOf(actingCommandFor(['import', 'git']))).toBeUndefined();
  });

  it('reads a non-local env too, so the value is passed through rather than special-cased', () => {
    expect(envFlagOf(actingCommandFor(['import', '--env', 'preview', 'git']))).toBe('preview');
  });

  // `align setup --local` is how a user ENTERS local mode, and it is not spelled `--env local`.
  // Without this the one command whose whole purpose is going private reported itself to the
  // cloud on any machine that had run `align login`.
  it('treats `setup --local` as the local env, since --local is not --env', () => {
    const program = new Command();
    program.exitOverride().name('align');
    program
      .command('setup')
      .option('--env <env>', 'environment')
      .option('--local', 'local-only setup')
      .action(() => {});
    expect(envFlagOf(actingCommandFor(['setup', '--local'], program))).toBe('local');
  });

  // The boundary: --local must not override an explicitly typed cloud env.
  it('lets an explicit --env win over --local rather than forcing local', () => {
    const program = new Command();
    program.exitOverride().name('align');
    program
      .command('setup')
      .option('--env <env>', 'environment')
      .option('--local', 'local-only setup')
      .action(() => {});
    expect(envFlagOf(actingCommandFor(['setup', '--env', 'preview', '--local'], program))).toBe(
      'preview',
    );
  });
});
