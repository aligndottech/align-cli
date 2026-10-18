import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { findOnPath } from './launch/detect.js';

/**
 * ALI-1779: whether Claude Code exists on this machine. `align setup` always writes the project
 * `.mcp.json`, which Claude Code reads, but a file nobody reads connects nothing: with no agent
 * installed the wizard must not say "Your agent is connected". It exists when its binary is on
 * PATH or its user config is on disk (`~/.claude.json`, `~/.claude/`).
 */
export function claudeCodeExists(
  deps: { home?: string; env?: Record<string, string | undefined>; platform?: string } = {},
): boolean {
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  if (findOnPath('claude', env, platform) !== null) return true;
  return existsSync(path.join(home, '.claude.json')) || existsSync(path.join(home, '.claude'));
}
