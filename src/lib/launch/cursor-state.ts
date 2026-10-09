import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isLocalAlignServer } from './project-state.js';

export interface CursorProjectState {
  /** A local align server is available to Cursor by any route (ours, or the user's own). */
  projectHasMcp: boolean;
  /** ~/.cursor/mcp.json: the file align adds to. */
  mcpFile: string;
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

/**
 * What Cursor would already read, in the project (.cursor/) and globally (~/.cursor/). Same
 * "present means doing the same job" rule as the other agents; unreadable counts as absent.
 */
export function readCursorState(cwd: string, home: string, opts: { localIsDefault: boolean }): CursorProjectState {
  const { localIsDefault } = opts;
  const mcpFile = path.join(home, '.cursor', 'mcp.json');
  const servers = [path.join(cwd, '.cursor', 'mcp.json'), mcpFile].map((f) => readJson(f)?.['mcpServers'] as Json | undefined);
  return {
    projectHasMcp: servers.some((s) => s?.['align-local'] !== undefined) || servers.some((s) => isLocalAlignServer(s?.['align'], localIsDefault)),
    mcpFile,
  };
}
