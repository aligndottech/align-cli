import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ALIGN_NUDGE_START, isAlignHookGroup } from '../agent-rules.js';

export interface ProjectState {
  projectHasHooks: boolean;
  projectHasMcp: boolean;
  projectHasBlock: boolean;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const hasAlignServer = (servers: unknown): boolean => typeof servers === 'object' && servers !== null && 'align' in servers;

function hasAlignHook(settings: Record<string, unknown> | null): boolean {
  const hooks = settings?.['hooks'] as Record<string, unknown> | undefined;
  const pre = hooks?.['PreToolUse'];
  return Array.isArray(pre) && pre.some(isAlignHookGroup);
}

function fileHasBlock(file: string): boolean {
  try {
    return readFileSync(file, 'utf8').includes(ALIGN_NUDGE_START);
  } catch {
    return false;
  }
}

/**
 * What Claude Code would already load for this directory, so a per-session injection never
 * doubles it. Unreadable or malformed files count as absent: the cost of a wrong "absent"
 * is a duplicate hook, the cost of a throw is no session at all.
 */
export function readProjectState(cwd: string, home: string): ProjectState {
  const claudeJson = readJson(path.join(home, '.claude.json'));
  const projectEntry = (claudeJson?.['projects'] as Record<string, { mcpServers?: unknown }> | undefined)?.[cwd];
  return {
    projectHasHooks: [
      path.join(cwd, '.claude', 'settings.json'),
      path.join(cwd, '.claude', 'settings.local.json'),
      path.join(home, '.claude', 'settings.json'),
    ].some((f) => hasAlignHook(readJson(f))),
    projectHasMcp:
      hasAlignServer(readJson(path.join(cwd, '.mcp.json'))?.['mcpServers']) ||
      hasAlignServer(claudeJson?.['mcpServers']) ||
      hasAlignServer(projectEntry?.mcpServers),
    projectHasBlock: [path.join(cwd, 'CLAUDE.md'), path.join(cwd, '.claude', 'CLAUDE.md')].some(fileHasBlock),
  };
}
