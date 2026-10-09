import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ALIGN_NUDGE_START, isAlignHookGroup } from '../agent-rules.js';

export interface ProjectState {
  projectHasPreHook: boolean;
  projectHasPostHook: boolean;
  projectHasMcp: boolean;
  projectHasBlock: boolean;
}

export interface ProjectStateOptions {
  /** Whether an align command with no --env reads the local graph on this machine. */
  localIsDefault: boolean;
}

type Json = Record<string, unknown>;

function readJson(file: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

/** The --env an align command line names, or undefined when it names none. */
function envOf(tokens: string[]): string | undefined {
  const i = tokens.indexOf('--env');
  if (i >= 0) return tokens[i + 1];
  return tokens.find((t) => t.startsWith('--env='))?.slice('--env='.length);
}

/** Does this command line read the LOCAL graph? An env that names another graph does not. */
export function readsLocal(tokens: string[], localIsDefault: boolean): boolean {
  const env = envOf(tokens);
  return env === undefined ? localIsDefault : env === 'local';
}

function isLocalAlignServer(entry: unknown, localIsDefault: boolean): boolean {
  const e = entry as { command?: unknown; args?: unknown } | null;
  const tokens = [e?.command, ...(Array.isArray(e?.args) ? (e.args as unknown[]) : [])].filter((t): t is string => typeof t === 'string');
  return tokens.includes('mcp') && tokens.some((t) => /^align(\.cmd)?$/.test(path.basename(t))) && readsLocal(tokens, localIsDefault);
}

function hasLocalHook(settings: Json | null, event: string, localIsDefault: boolean): boolean {
  const groups = (settings?.['hooks'] as Json | undefined)?.[event];
  if (!Array.isArray(groups)) return false;
  return groups.some((g: unknown) => {
    if (!isAlignHookGroup(g)) return false;
    const hooks = (g as { hooks: Array<{ command?: unknown }> }).hooks;
    return hooks.some((h) => {
      const tokens = String(h?.command ?? '').split(/\s+/);
      return String(h?.command ?? '').includes('align check --advisory') && readsLocal(tokens, localIsDefault);
    });
  });
}

function fileHasBlock(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').includes(ALIGN_NUDGE_START);
  } catch {
    return false;
  }
}

/**
 * The cwd and every directory above it. Claude Code loads CLAUDE.md and CLAUDE.local.md "from
 * your current working directory and every directory above it" (code.claude.com/docs/en/memory,
 * "How CLAUDE.md files load"), with no stop at a git root.
 */
function ancestorsOf(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.dirname(dir) === dir) return dirs;
  }
}

/**
 * What Claude Code would already load for this directory, so a per-session injection never
 * doubles it. "Present" means present AND doing the same job: a hook or server aimed at
 * another graph does not stand in for ours. Unreadable or malformed files count as absent:
 * the cost of a wrong "absent" is a duplicate, the cost of a throw is no session at all.
 */
export function readProjectState(cwd: string, home: string, opts: ProjectStateOptions): ProjectState {
  const { localIsDefault } = opts;
  const claudeJson = readJson(path.join(home, '.claude.json'));
  const projectEntry = (claudeJson?.['projects'] as Record<string, Json> | undefined)?.[cwd];
  const settingsFiles = [
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(home, '.claude', 'settings.json'),
  ].map(readJson);

  const disabled = [...settingsFiles, projectEntry ?? null].some((s) => {
    const list = s?.['disabledMcpjsonServers'];
    return Array.isArray(list) && list.includes('align');
  });
  const projectMcp = (readJson(path.join(cwd, '.mcp.json'))?.['mcpServers'] as Json | undefined)?.['align'];
  const userMcp = (claudeJson?.['mcpServers'] as Json | undefined)?.['align'];
  const projectScopedMcp = (projectEntry?.['mcpServers'] as Json | undefined)?.['align'];

  const blockFiles = [
    ...ancestorsOf(cwd).flatMap((d) => [path.join(d, 'CLAUDE.md'), path.join(d, '.claude', 'CLAUDE.md'), path.join(d, 'CLAUDE.local.md')]),
    path.join(home, '.claude', 'CLAUDE.md'),
  ];

  return {
    projectHasPreHook: settingsFiles.some((s) => hasLocalHook(s, 'PreToolUse', localIsDefault)),
    projectHasPostHook: settingsFiles.some((s) => hasLocalHook(s, 'PostToolUse', localIsDefault)),
    projectHasMcp:
      (!disabled && isLocalAlignServer(projectMcp, localIsDefault)) ||
      isLocalAlignServer(userMcp, localIsDefault) ||
      isLocalAlignServer(projectScopedMcp, localIsDefault),
    projectHasBlock: blockFiles.some(fileHasBlock),
  };
}
