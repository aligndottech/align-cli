import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { createConfigStore } from './config.js';
import { createLocalDb } from './local-db.js';

/**
 * Reproduces the OLD hand-rolled linux directory exactly - the one that never read
 * XDG_CONFIG_HOME - because that is genuinely where an existing user's local.db sits
 * today, on disk, regardless of what env-paths would now compute for them. Exported
 * only so src/index.ts can pass it as migrateLocalDb's "old" argument at real startup;
 * it must never be updated to match getLocalDbPath()'s current logic - the whole point
 * is that it stays frozen as a historical record of what used to be computed.
 */
export function legacyLocalDbDir(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Preferences', 'align-cli');
  if (process.platform === 'win32') return path.join(process.env['APPDATA'] ?? os.homedir(), 'align-cli');
  return path.join(os.homedir(), '.config', 'align-cli');
}

/**
 * Copilot review on #231: switching getLocalDbPath() to env-paths (which honours
 * XDG_CONFIG_HOME) means anyone whose XDG_CONFIG_HOME differs from the default - or
 * simply anyone upgrading past this fix - has their real local.db sitting at the OLD
 * hand-rolled path while the new code looks elsewhere. Without this, an existing local
 * graph silently vanishes. Same shape as config.ts's migrateConfigDirectory: copy only
 * when the new location has nothing yet, never overwrite, never delete the old files.
 * WAL and SHM sidecars travel with the main file - local-db.test.ts's own cleanup code
 * already treats '', '-wal', '-shm' as one unit.
 */
export function migrateLocalDb(oldDir: string, newDir: string): void {
  const oldFile = path.join(oldDir, 'local.db');
  const newFile = path.join(newDir, 'local.db');
  if (fs.existsSync(newFile) || !fs.existsSync(oldFile)) return;
  fs.mkdirSync(newDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${oldFile}${suffix}`;
    if (fs.existsSync(from)) fs.copyFileSync(from, `${newFile}${suffix}`);
  }
}

/**
 * Was a hand-rolled darwin/win32/linux branch, independent of the ONE env-paths lookup
 * config.ts already uses under the hood (via the `conf` package). Two writers of the
 * same platform-directory fact had already
 * drifted (config.ts's conf instance wrote to a `-nodejs`-suffixed directory this file
 * never knew about), and would drift further on Windows even with that fixed - env-paths
 * nests config under a `Config` subdirectory this hand-written branch never added, and
 * the Linux branch never honoured XDG_CONFIG_HOME the way env-paths does. Deferring to
 * env-paths directly, with the same `suffix: ''` config.ts passes, makes this the same
 * directory createConfigStore() resolves to, by construction rather than by convention.
 */
export function getLocalDbPath(): string {
  const configDir = envPaths('align-cli', { suffix: '' }).config;
  return path.join(configDir, 'local.db');
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
