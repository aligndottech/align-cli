#!/usr/bin/env node
import envPaths from 'env-paths';
import { migrateConfigDirectory } from './lib/config.js';
import { legacyLocalDbDir, migrateLocalDb } from './lib/local-mode.js';
import { buildProgram } from './cli.js';

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

// The command tree lives in cli.ts, built from src/commands/registry.ts (ALI-951), so the
// help, the doc generator and the tests read the same list this entry point parses.
buildProgram().parseAsync().catch(handleFatal);
