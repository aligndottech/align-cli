import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isLocalAlignServer, readsLocal } from './project-state.js';

export interface CursorProjectState {
  /** Our `align-local` entry is in a Cursor mcp.json already (so Cursor has been told to trust it). */
  hasAlignLocalEntry: boolean;
  /** A local align server is available to Cursor by any route (ours, or the user's own). */
  projectHasMcp: boolean;
  /** Both pre and post edit checks, aimed at the local graph, are in a hooks.json Cursor reads. */
  hooksPresent: boolean;
  /** ~/.cursor/mcp.json and ~/.cursor/hooks.json: the files align adds to. */
  mcpFile: string;
  hooksFile: string;
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

function hasLocalHook(file: Json | null, event: string, localIsDefault: boolean): boolean {
  const entries = (file?.['hooks'] as Json | undefined)?.[event];
  if (!Array.isArray(entries)) return false;
  return entries.some((e: unknown) => {
    const command = String((e as { command?: unknown } | null)?.command ?? '');
    return command.includes('align check --advisory') && readsLocal(command.split(/\s+/), localIsDefault);
  });
}

/**
 * What Cursor would already read, in the project (.cursor/) and globally (~/.cursor/). Same
 * "present means doing the same job" rule as the other agents; unreadable counts as absent.
 */
export function readCursorState(cwd: string, home: string, opts: { localIsDefault: boolean }): CursorProjectState {
  const { localIsDefault } = opts;
  const mcpFile = path.join(home, '.cursor', 'mcp.json');
  const hooksFile = path.join(home, '.cursor', 'hooks.json');
  const servers = [path.join(cwd, '.cursor', 'mcp.json'), mcpFile].map((f) => readJson(f)?.['mcpServers'] as Json | undefined);
  const hookFiles = [path.join(cwd, '.cursor', 'hooks.json'), hooksFile].map(readJson);
  const hasAlignLocalEntry = servers.some((s) => s?.['align-local'] !== undefined);
  return {
    hasAlignLocalEntry,
    projectHasMcp: hasAlignLocalEntry || servers.some((s) => isLocalAlignServer(s?.['align'], localIsDefault)),
    hooksPresent: ['preToolUse', 'postToolUse'].every((ev) => hookFiles.some((f) => hasLocalHook(f, ev, localIsDefault))),
    mcpFile,
    hooksFile,
  };
}
