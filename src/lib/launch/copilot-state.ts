import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isLocalAlignServer } from './project-state.js';

export interface CopilotProjectState {
  /** Copilot would already start a local align server: our align-local, or the user's align at --env local. */
  projectHasMcp: boolean;
}

type Json = Record<string, unknown>;

function servers(file: string): Json | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Json | null;
    return (parsed?.['mcpServers'] ?? undefined) as Json | undefined;
  } catch {
    return undefined;
  }
}

/** The cwd and each directory above it, up to and including the git root (or the filesystem root). */
function projectDirs(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return dirs;
  }
}

/**
 * What Copilot CLI would already load here (`copilot mcp --help`: user ~/.copilot/mcp-config.json,
 * workspace .mcp.json or .github/mcp.json), so the per-session flag never doubles it. The user
 * file follows a user-set COPILOT_HOME; align reads it and never sets it. Unreadable is absent.
 */
export function readCopilotState(cwd: string, home: string, opts: { localIsDefault: boolean }, env: Record<string, string | undefined> = {}): CopilotProjectState {
  const copilotHome = env['COPILOT_HOME'] ? env['COPILOT_HOME'] : path.join(home, '.copilot');
  const files = [path.join(copilotHome, 'mcp-config.json'), ...projectDirs(cwd).flatMap((d) => [path.join(d, '.mcp.json'), path.join(d, '.github', 'mcp.json')])];
  return {
    projectHasMcp: files.map(servers).some((s) => s?.['align-local'] !== undefined || isLocalAlignServer(s?.['align'], opts.localIsDefault)),
  };
}
