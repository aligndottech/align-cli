#!/usr/bin/env node
import './lib/startup-env.js'; // FIRST: snapshot the shell's env before any module can change it
import './lib/startup-xdg.js'; // SECOND: drop a relative XDG_* before anything computes a directory from it
import './lib/startup-backfill-track.js'; // THIRD: if align_backfill started this process, record how it ends
import { writeSync } from 'node:fs';
import envPaths from 'env-paths';
import { migrateConfigDirectory } from './lib/config.js';
import { getLocalDbPath, legacyLocalDbDir, migrateLocalDb } from './lib/local-mode.js';
import { excludeGraphFromBackups } from './lib/backup-exclusion.js';
import { buildProgram } from './cli.js';
import { resolveDetectorVersion } from './detector/detector-version.js';
import { describeFatal } from './lib/fatal.js';
import { printRedactionNotice } from './lib/redaction-notice.js';

// Last-resort guard so no command ever dumps a raw Node stack trace at a user.
// Individual commands still handle their own expected errors; this only catches
// the unexpected (e.g. a native/db error escaping an async action).
function handleFatal(err: unknown): never {
  const r = describeFatal(err, Boolean(process.env['ALIGN_DEBUG']));
  if (r.stack) console.error(r.stack);
  for (const line of r.lines) console.error(line);
  process.exit(r.code);
}
process.on('uncaughtException', handleFatal);
process.on('unhandledRejection', handleFatal);
// A command that exits before its postAction hook still tells the person how many secrets it kept
// out of the local graph. Taking the notice resets it, so this never repeats one cli.ts printed.
// A synchronous write: an asynchronous stderr pipe (macOS) is not flushed once 'exit' runs.
process.on('exit', () => printRedactionNotice((line) => { try { writeSync(2, `${line}\n`); } catch { /* stderr closed */ } }));

// One-time directory migrations (ALI-819, Copilot review on #231), run exactly once at
// real process startup - never inside createConfigStore()/getLocalDbPath() themselves,
// which stay pure so tests that mock `conf` don't also need to mock the filesystem.
// A migration is a nice-to-have, never a requirement: an unreadable/unwritable
// ~/.config on some machine must not stop align from running the command the user
// actually asked for, so failures here are swallowed rather than reaching handleFatal.
try {
  migrateConfigDirectory(envPaths('align-cli', { suffix: 'nodejs' }).config, envPaths('align-cli', { suffix: '' }).config);
  migrateLocalDb(legacyLocalDbDir(), envPaths('align-cli', { suffix: '' }).config);
  // An existing local graph is excluded from Time Machine and cache-aware backups on its first run
  // after an upgrade (once; a no-op without a graph). Best effort, never fatal (backup-exclusion.ts).
  excludeGraphFromBackups(getLocalDbPath());
} catch (e) {
  if (process.env['ALIGN_DEBUG']) console.error('align: startup migration failed (non-fatal):', e);
}

// An unknown ALIGN_DETECTOR is fatal before any command runs: a typo must never run the default silently.
try {
  resolveDetectorVersion();
} catch (e) {
  handleFatal(e);
}

// The command tree lives in cli.ts, built from src/commands/registry.ts (ALI-951), so the
// help, the doc generator and the tests read the same list this entry point parses.
buildProgram().parseAsync().catch(handleFatal);
