#!/usr/bin/env node
import { Command } from 'commander';
import envPaths from 'env-paths';
import pkg from '../package.json' with { type: 'json' };
const { version } = pkg;
import { migrateConfigDirectory } from './lib/config.js';
import { legacyLocalDbDir, migrateLocalDb } from './lib/local-mode.js';
import { registerLoginCommands } from './commands/login.js';
import { registerCaptureCommand } from './commands/capture.js';
import { registerImportCommand } from './commands/import.js';
import { registerSearchCommand } from './commands/search.js';
import { registerCheckCommand } from './commands/check.js';
import { registerAdjudicateCommand } from './commands/adjudicate.js';
import { registerRatifyCommand } from './commands/ratify.js';
import { registerPushCommand } from './commands/push.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerLocalCommand } from './commands/local.js';
import { registerDecisionsCommand } from './commands/decisions/index.js';
import { registerConnectorCommands } from './commands/connector/index.js';
import { registerDevCommands } from './commands/dev/index.js';
import { registerSpacesCommand } from './commands/spaces.js';
import { registerLinksCommand } from './commands/links.js';
import { registerDriftCommand } from './commands/drift.js';
import { registerStatusCommand } from './commands/status.js';
import { registerContextCommand } from './commands/context.js';
import { registerEnvCommand } from './commands/env.js';
import { registerTelemetryCommand } from './commands/telemetry.js';
import { registerAskCommand } from './commands/why.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerExportCommand } from './commands/export.js';
import { registerInviteCommand } from './commands/invite.js';
import { runDefaultAction } from './commands/default-action.js';

// Last-resort guard so no command ever dumps a raw Node stack trace at a user.
// Individual commands still handle their own expected errors; this only catches
// the unexpected (e.g. a native/db error escaping an async action).
function handleFatal(err: unknown): never {
  const e = err instanceof Error ? err : new Error(String(err));
  if (process.env['ALIGN_DEBUG']) {
    console.error(e);
  } else {
    console.error(`\nalign: ${e.message}\n`);
    console.error('Run with ALIGN_DEBUG=1 for the full stack trace, or report it at');
    console.error('https://github.com/aligndottech/align-cli/issues');
  }
  process.exit(1);
}
process.on('uncaughtException', handleFatal);
process.on('unhandledRejection', handleFatal);

// One-time directory migrations (ALI-819, Copilot review on #231), run exactly once at
// real process startup - never inside createConfigStore()/getLocalDbPath() themselves,
// which stay pure so tests that mock `conf` don't also need to mock the filesystem.
// A migration is a nice-to-have, never a requirement: an unreadable/unwritable
// ~/.config on some machine must not stop align from running the command the user
// actually asked for, so failures here are swallowed rather than reaching handleFatal.
try {
  migrateConfigDirectory(envPaths('align-cli', { suffix: 'nodejs' }).config, envPaths('align-cli', { suffix: '' }).config);
  migrateLocalDb(legacyLocalDbDir(), envPaths('align-cli', { suffix: '' }).config);
} catch (e) {
  if (process.env['ALIGN_DEBUG']) console.error('align: startup migration failed (non-fatal):', e);
}

const program = new Command();

program
  .name('align')
  .description('Align CLI - capture decisions, check alignment, and manage connectors')
  .version(version);

// ALI-954: the install beacon - once per install id, on the very first run, BEFORE the
// command's action and therefore before any prompt it shows. preAction on the root fires for
// the root's own action (bare `align`) and for every subcommand. Fire-and-forget: the
// request is started here and Node keeps the process alive until it completes or the 2s
// timeout aborts it, so the wizard never waits on a blackholed network. Skips itself under
// DO_NOT_TRACK / ALIGN_TELEMETRY, after `align telemetry off`, when a cloud token is already
// in hand, and when the first command IS `align telemetry ...` (see recordInstallBeacon).
program.hook('preAction', async (_thisCommand, actionCommand) => {
  const { invocationCommandPath, recordInstallBeacon } = await import('./lib/usage-telemetry.js');
  void recordInstallBeacon(invocationCommandPath(actionCommand));
});

// ALI-403/ALI-618/ALI-954: one usage event per invocation, so CLI activation and weekly
// retention are countable in both cloud mode (opt-out) and local-embedded mode (with the stored
// consent - a no-op until the setup prompt or `align telemetry on` grants it). No-op under
// ALIGN_TELEMETRY=0 / DO_NOT_TRACK=1 in either mode. Runs after the command's own work, so a
// slow or blackholed gateway cannot delay the output the user came for.
program.hook('postAction', async (_thisCommand, actionCommand) => {
  const { envFlagOf, invocationCommandPath, recordInvocationUsage } = await import('./lib/usage-telemetry.js');
  // Full path ("local ask"), not the leaf name ("ask"), so recordCommandUsage can exclude the
  // offline `local` group - a cloud-logged-in user running it still has a token in hand. The
  // root action (bare `align`, ALI-773) has no parent and reports as 'align' (ALI-949) - the
  // walk used to yield '' for it, so the primary first-run path was never counted.
  // The command's OWN --env, not the default env: `align setup --local` leaves the default
  // pointing at cloud on purpose, so reading the default reported local sessions as cloud ones.
  // envFlagOf reads through to the parent, because `--env` is declared on both the `import`
  // group and its subcommands and Commander awards it to the parent (align-cli#79).
  await recordInvocationUsage(envFlagOf(actionCommand), invocationCommandPath(actionCommand));
});

// Environment targeting
registerEnvCommand(program);
registerTelemetryCommand(program);

// Auth + onboarding
registerLoginCommands(program);
registerSetupCommand(program);
registerInviteCommand(program);

// Customer: decision capture + import
registerCaptureCommand(program);
registerImportCommand(program);

// Customer: search + query
registerSearchCommand(program);
registerAskCommand(program);
registerDecisionsCommand(program);
registerExportCommand(program);
registerSpacesCommand(program);
registerLinksCommand(program);
registerDriftCommand(program);
registerStatusCommand(program);
registerContextCommand(program);

// Customer: CI/alignment check
registerCheckCommand(program);
registerAdjudicateCommand(program);
// ALI-831: agent decisions as claims - the human act, and the per-item promotion after it.
registerRatifyCommand(program);
registerPushCommand(program);

// Customer: MCP server
registerMcpCommand(program);

// Customer: local-first mode (no cloud account required)
registerLocalCommand(program);

// Internal: only registered when ALIGN_INTERNAL=1 (Align team local dev)
if (process.env.ALIGN_INTERNAL === '1') {
  registerConnectorCommands(program);
  registerDevCommands(program);
}

// `align` with no arguments (ALI-773). Without this Commander prints a twenty-command help
// wall, which is what a new user's first instinct gets them. Registered AFTER every command
// so it only fires when none of them matched; `align --help` and `align -V` are handled by
// Commander before this runs.
program.action(runDefaultAction);

program.parseAsync().catch(handleFatal);
