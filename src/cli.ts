import { Command, Help } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { COMMAND_REGISTRY, ROOT_SUMMARY, visibleEntries } from './commands/registry.js';
import { runDefaultAction } from './commands/default-action.js';

const { version } = pkg;

/** Where every hidden command is documented; `align --help` points here instead of listing them. */
export const COMMANDS_DOC_URL = 'https://github.com/aligndottech/align-cli/blob/main/docs/commands.md';

/**
 * The five-entry root help (ALI-951). Rendered from the registry, never from Commander's
 * command list, so a command is visible only by choosing so in COMMAND_REGISTRY. Subcommand
 * help (`align connect --help`) keeps Commander's default, which lists that command's own
 * subcommands and flags.
 */
export function renderRootHelp(program: Command): string {
  const rows: Array<[string, string]> = [['align', ROOT_SUMMARY]];
  for (const entry of visibleEntries()) {
    for (const name of entry.names) {
      const cmd = program.commands.find((c) => c.name() === name);
      const args = cmd?.registeredArguments.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(' ') ?? '';
      rows.push([args ? `${name} ${args}` : name, entry.summary]);
    }
  }
  const width = Math.max(...rows.map(([term]) => term.length));
  const lines = rows.map(([term, summary]) => `  ${term.padEnd(width)}   ${summary}`);
  return [
    'Usage: align [command]',
    '',
    ...lines,
    '',
    `Every other command: ${COMMANDS_DOC_URL}`,
    '  -V, --version   print the version',
    '  -h, --help      show this help',
    '',
  ].join('\n');
}

export interface BuildProgramOptions {
  /** Register the ALIGN_INTERNAL=1 commands too. Default: the env var decides. */
  internal?: boolean;
  /** Tests: make Commander throw instead of calling process.exit, and capture its output.
   *  Applied BEFORE registration so every subcommand inherits it. */
  exitOverride?: boolean;
  output?: { writeOut?: (s: string) => void; writeErr?: (s: string) => void };
}

/**
 * The whole command tree, built from the registry and nothing else (ALI-951). index.ts
 * calls this once and parses; tests and the doc generator call it to read the tree without
 * running anything.
 */
export function buildProgram(options: BuildProgramOptions = {}): Command {
  const program = new Command();
  if (options.exitOverride) program.exitOverride();
  if (options.output) program.configureOutput(options.output);

  program
    .name('align')
    .description('Align CLI - capture decisions, check alignment, and manage connectors')
    .version(version);

  // ALI-403/ALI-618: one usage event per invocation, so CLI activation and weekly retention are
  // countable in both cloud mode (opt-out) and local-embedded mode (opt-in, ALI-618 - a no-op
  // until `align telemetry on` is run). No-op under ALIGN_TELEMETRY=0 in either mode. Runs after
  // the command's own work, so a slow or blackholed gateway cannot delay the output the user came
  // for.
  program.hook('postAction', async (_thisCommand, actionCommand) => {
    const { envFlagOf, invocationCommandPath, recordInvocationUsage } = await import('./lib/usage-telemetry.js');
    // Full path ("local ask"), not the leaf name ("ask"), so recordCommandUsage can exclude the
    // offline `local` group - a cloud-logged-in user running it still has a token in hand. The
    // root action (bare `align`, ALI-773) has no parent and reports as 'align' (ALI-949) - the
    // walk used to yield '' for it, so the primary first-run path was never counted.
    // The command's OWN --env, not the default env: `align setup --local` leaves the default
    // pointing at cloud on purpose, so reading the default reported local sessions as cloud ones.
    // envFlagOf reads through to the parent, because `--env` is declared on both the `connect`
    // group and its subcommands and Commander awards it to the parent (align-cli#79).
    await recordInvocationUsage(envFlagOf(actionCommand), invocationCommandPath(actionCommand));
  });

  const internal = options.internal ?? process.env.ALIGN_INTERNAL === '1';
  for (const entry of COMMAND_REGISTRY) {
    if (entry.internal && !internal) continue;
    entry.register(program);
  }

  // `align` with no arguments (ALI-773). Without this Commander prints a twenty-command help
  // wall, which is what a new user's first instinct gets them. Registered AFTER every command
  // so it only fires when none of them matched; `align --help` and `align -V` are handled by
  // Commander before this runs.
  program.action(runDefaultAction);

  // After registration, so subcommands (created above) keep the default help - configureHelp
  // is copied into subcommands at creation time, not looked up through the parent.
  const defaultHelp = new Help();
  program.configureHelp({
    formatHelp: (cmd, helper) => (cmd === program ? renderRootHelp(program) : defaultHelp.formatHelp(cmd, helper)),
  });

  return program;
}
