import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ALIGN_NUDGE_START } from '../agent-rules.js';
import { readsLocal } from './project-state.js';

export interface OpenCodeProjectState {
  projectHasPlugin: boolean;
  projectHasMcp: boolean;
  projectHasBlock: boolean;
}

type Json = Record<string, unknown>;

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file: string): Json | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

/**
 * The cwd and each directory above it, up to and including the git root (OpenCode's own
 * project boundary: it does not read config or AGENTS.md above the worktree). With no .git
 * anywhere, all the way up.
 */
function projectDirs(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return dirs;
  }
}

/** ~/.config/opencode, or $XDG_CONFIG_HOME/opencode when that is absolute (same rule as detectEditors). */
function globalDir(home: string, env: Record<string, string | undefined>): string {
  const xdg = env['XDG_CONFIG_HOME'];
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config'), 'opencode');
}

/** The plugin writer's own output: the check call, and an optional `"--env", "<name>"` pair. */
function pluginReadsLocal(text: string | null, localIsDefault: boolean): boolean {
  if (text === null || !text.includes('"check", "--advisory", "--format", "opencode"')) return false;
  const env = /"--env",\s*"([^"]+)"/.exec(text)?.[1];
  return readsLocal(env === undefined ? [] : ['--env', env], localIsDefault);
}

function isLocalAlignServer(entry: unknown, localIsDefault: boolean): boolean {
  const e = entry as { type?: unknown; command?: unknown } | null;
  if (e?.type !== 'local' || !Array.isArray(e.command)) return false;
  const tokens = e.command.filter((t): t is string => typeof t === 'string');
  return tokens.includes('mcp') && tokens.some((t) => /^align(\.cmd)?$/.test(path.basename(t))) && readsLocal(tokens, localIsDefault);
}

/**
 * What OpenCode would already load for this directory, so a per-session injection never doubles
 * it. "Present" means present AND doing the same job: a plugin or server aimed at another graph
 * does not stand in for ours. Unreadable or malformed files count as absent: the cost of a wrong
 * "absent" is a duplicate, the cost of a throw is no session at all. Only `.json` configs are
 * read; a commented `.jsonc` does not parse and reads as absent.
 */
export function readOpenCodeState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined> = {},
): OpenCodeProjectState {
  const { localIsDefault } = opts;
  const dirs = projectDirs(cwd);
  const global = globalDir(home, env);
  const configDirs = [...dirs.map((d) => path.join(d, '.opencode')), global];
  const configFiles = [...dirs.map((d) => path.join(d, 'opencode.json')), ...configDirs.map((d) => path.join(d, 'opencode.json'))];
  const instructionFiles = [
    ...dirs.flatMap((d) => [path.join(d, 'AGENTS.md'), path.join(d, 'CLAUDE.md')]),
    path.join(global, 'AGENTS.md'),
  ];
  return {
    projectHasPlugin: configDirs.some((d) => pluginReadsLocal(readText(path.join(d, 'plugins', 'align.js')), localIsDefault)),
    projectHasMcp: configFiles.some((f) => isLocalAlignServer((readJson(f)?.['mcp'] as Json | undefined)?.['align'], localIsDefault)),
    projectHasBlock: instructionFiles.some((f) => readText(f)?.includes(ALIGN_NUDGE_START) ?? false),
  };
}
