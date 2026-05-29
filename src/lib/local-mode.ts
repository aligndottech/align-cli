import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from './config.js';
import { createLocalDb } from './local-db.js';
import { detectEditors, writeMcpConfig } from './mcp-setup.js';

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

export async function initLocalMode(opts: { quiet?: boolean } = {}) {
  const dbPath = getLocalDbPath();
  const config = createConfigStore();
  config.setLocalMode(dbPath);
  config.setDefaultEnv('local');

  // Initialize schema (idempotent)
  const db = createLocalDb(dbPath);
  db.close();

  if (!opts.quiet) {
    const editors = detectEditors();
    for (const target of editors) {
      writeMcpConfig(target, 'local');
    }
  }

  return { dbPath };
}
