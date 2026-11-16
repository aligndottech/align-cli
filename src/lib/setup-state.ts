import { existsSync } from 'node:fs';
import path from 'node:path';
import { alignConfigDir } from './private-files.js';

/**
 * Has Align ever been set up here? True when ~/.align holds a config or a local graph, when a
 * project folder (cwd or a parent) has its own `.align`, or when ALIGN_ENV names an environment.
 * Read-only on purpose: the Claude Code plugin runs `check --advisory` for people who never
 * ran setup, and asking this must create nothing (createConfigStore makes ~/.align).
 */
export function isAlignSetUp(cwd: string): boolean {
  if (process.env['ALIGN_ENV']) return true;
  const home = alignConfigDir();
  if (existsSync(path.join(home, 'config.json')) || existsSync(path.join(home, 'local.db'))) return true;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    // ~/.align is the user-level folder checked above, not a project marker.
    if (path.join(dir, '.align') !== home && existsSync(path.join(dir, '.align'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}
