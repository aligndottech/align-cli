import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { alignConfigDir } from './private-files.js';

type SavedEnv = { authToken?: unknown; mode?: unknown };

/**
 * Has Align been set up here? Evidence of a choice a person made: ALIGN_ENV, a project `.align`
 * folder in `cwd`, or a saved ~/.align/config.json holding an environment with a login or a
 * local/demo mode. NOT evidence: the config file merely existing, or ~/.align/local.db - the
 * MCP server creates both on a fresh machine without any setup. Read-only on purpose: the Claude
 * Code plugin runs `check --advisory` for people who never ran setup, and asking this must create
 * nothing (createConfigStore makes ~/.align).
 */
export function isAlignSetUp(cwd: string): boolean {
  if (process.env['ALIGN_ENV']) return true;
  if (existsSync(path.join(path.resolve(cwd), '.align'))) return true;
  try {
    const saved = JSON.parse(readFileSync(path.join(alignConfigDir(), 'config.json'), 'utf8')) as { environments?: Record<string, SavedEnv> };
    return Object.values(saved.environments ?? {}).some((e) => Boolean(e?.authToken) || e?.mode === 'local-embedded' || e?.mode === 'demo');
  } catch {
    return false;
  }
}
