import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from './config.js';
import { createLocalDb } from './local-db.js';

export function getLocalDbPath(): string {
  let configDir: string;
  if (process.platform === 'darwin') {
    configDir = path.join(os.homedir(), 'Library', 'Preferences', 'align-cli');
  } else if (process.platform === 'win32') {
    configDir = path.join(process.env['APPDATA'] ?? os.homedir(), 'align-cli');
  } else {
    configDir = path.join(os.homedir(), '.config', 'align-cli');
  }
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
