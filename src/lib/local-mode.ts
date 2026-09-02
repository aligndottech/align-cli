import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { createConfigStore } from './config.js';
import { createLocalDb } from './local-db.js';

const LOCAL_DB_FILE = 'local.db';

/**
 * The graph is one logical database spread over three files: the DB itself plus the WAL
 * sidecars SQLite maintains under `PRAGMA journal_mode = WAL` (local-db.ts). Committed
 * transactions live in `-wal` until a checkpoint, so anything that relocates or deletes
 * the database has to treat all three as one unit - `align local reset` for the delete
 * side, migrateLocalDbDirectory below for the copy side. One writer of that fact, because
 * a migration that copied only `local.db` would drop the most recent decisions and report
 * success.
 */
export const LOCAL_DB_SUFFIXES = ['', '-wal', '-shm'] as const;

/**
 * Where getLocalDbPath() put the graph before it deferred to env-paths: a hand-rolled
 * darwin/win32/linux branch. Kept verbatim, and only as a migration SOURCE - it is the
 * one record of where an existing user's decisions actually are, so reproducing it
 * exactly is the point, and this is the single place the old guesswork is still correct.
 */
export function legacyLocalDbDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Preferences', 'align-cli');
  }
  if (process.platform === 'win32') {
    return path.join(process.env['APPDATA'] ?? os.homedir(), 'align-cli');
  }
  return path.join(os.homedir(), '.config', 'align-cli');
}

/**
 * The sibling of config.ts's migrateConfigDirectory, for the other half of local state,
 * and it exists for the same reason: moving where we read from without carrying the
 * existing data across is a silent regression, not a relocation.
 *
 * Switching to env-paths did not only drop the `-nodejs` suffix - it changed the directory
 * outright on two platforms. On Windows env-paths nests config under a `Config`
 * subdirectory the hand-rolled branch never added; on Linux it honours XDG_CONFIG_HOME,
 * which that branch ignored. macOS and default Linux already agreed, which is why testing
 * on those two cannot surface it: the fixture never crosses the boundary.
 *
 * Same contract as the config migration - one-time, idempotent, fires only when the new
 * location has no graph yet, never overwrites, never deletes the legacy copy. The sidecars
 * travel with the DB or not at all: grafting a `-wal` onto a database it did not come from
 * hands SQLite committed frames belonging to another file.
 */
export function migrateLocalDbDirectory(legacyDir: string, newDir: string): void {
  const legacyDb = path.join(legacyDir, LOCAL_DB_FILE);
  const newDb = path.join(newDir, LOCAL_DB_FILE);
  if (fs.existsSync(newDb) || !fs.existsSync(legacyDb)) return;

  fs.mkdirSync(newDir, { recursive: true });
  for (const suffix of LOCAL_DB_SUFFIXES) {
    const from = `${legacyDb}${suffix}`;
    if (fs.existsSync(from)) fs.copyFileSync(from, `${newDb}${suffix}`);
  }
}

/**
 * Was a hand-rolled darwin/win32/linux branch, independent of the ONE conf.ts already
 * uses under the hood. Two writers of the same platform-directory fact had already
 * drifted (config.ts's conf instance wrote to a `-nodejs`-suffixed directory this file
 * never knew about), and would drift further on Windows even with that fixed - env-paths
 * nests config under a `Config` subdirectory this hand-written branch never added, and
 * the Linux branch never honoured XDG_CONFIG_HOME the way env-paths does. Deferring to
 * env-paths directly, with the same `suffix: ''` config.ts passes, makes this the same
 * directory createConfigStore() resolves to, by construction rather than by convention.
 *
 * The migration call sits here rather than at each call site because this is the only
 * function that produces the canonical path, and its callers reach it through
 * `env.localDbPath ?? getLocalDbPath()`. So a returning user with a stored path never gets
 * here and keeps reading the graph they already have, while `align setup --local`, which
 * does come through here and writes the resolved path back to config, finds the migrated
 * graph instead of creating an empty database beside it.
 */
export function getLocalDbPath(): string {
  const configDir = envPaths('align-cli', { suffix: '' }).config;
  migrateLocalDbDirectory(legacyLocalDbDir(), configDir);
  return path.join(configDir, LOCAL_DB_FILE);
}

/**
 * `quiet` is gone (ALI-776). It gated exactly one thing - writing every detected editor's
 * global MCP config - and that moved to connectDetectedAgents, which asks first. An option
 * that no longer changes anything reads as a feature and outlives the behaviour it named.
 */
export async function initLocalMode() {
  const dbPath = getLocalDbPath();
  const config = createConfigStore();
  config.setLocalMode(dbPath);
  // Do NOT flip the global default env to 'local'. The MCP server is wired to
  // local mode via the '--env local' flag written into each editor's MCP config
  // by connectDetectedAgents, so the agent uses local mode without hijacking
  // every other `align` command - those would hit a local client that does not
  // implement cloud-only methods and crash.

  // Initialize schema (idempotent)
  const db = createLocalDb(dbPath);
  db.close();

  // This used to write every detected editor's GLOBAL MCP config right here, whenever
  // `quiet` was false - silently, from a function whose name says it initialises a graph.
  // ~/.claude.json and a Claude Desktop config are user-level files people curate across
  // every project, and editing one without a word is the kind of thing someone finds weeks
  // later and resents (ALI-776).
  //
  // connectDetectedAgents is the single writer now, and it asks. Both callers of this
  // function invoke it immediately afterwards, so nothing lost the wiring - it just gained
  // a question.
  return { dbPath };
}
