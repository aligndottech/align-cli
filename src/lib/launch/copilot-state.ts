import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type AlignLocalState, foldLayers, type Layer, parseJsonc } from './strict-entry.js';

export type CopilotProjectState = AlignLocalState;

function layer(file: string): Layer {
  let text: string | null = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // missing or unreadable: no servers
  }
  return { file, servers: parseJsonc(text)?.['mcpServers'] };
}

/** cwd up to and including the git root; with no .git anywhere above, cwd alone. Never past the root. */
function workspaceDirs(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (existsSync(path.join(dir, '.git'))) return dirs;
    if (path.dirname(dir) === dir) return [cwd];
  }
}

/**
 * What Copilot CLI (1.0.95) would already load for align. User: $COPILOT_HOME (or ~/.copilot)
 * /mcp-config.json. Workspace: .mcp.json and .github/mcp.json from cwd up to the git root.
 *
 * Copilot loads the workspace files only in a trusted folder, but that verdict comes from its
 * native runtime and several sources (its own store, IDE workspace folders, settings), none of
 * which align can read reliably; only COPILOT_ALLOW_ALL=true is certain. And whether
 * --additional-mcp-config replaces a same-named server whole is also native. So, both ways safe:
 *  - a workspace entry counts as "already present" only under COPILOT_ALLOW_ALL=true
 *    (otherwise inject: the worst case is a duplicate server, never a missing graph);
 *  - a non-canonical align-local in ANY of these files is a conflict (no injection), because
 *    a merged, repo-shaped align-local must never be launched.
 */
export function readCopilotState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
): CopilotProjectState {
  const o = { ...opts, platform, host: 'copilot' as const };
  const userFile = path.join(env['COPILOT_HOME'] ? env['COPILOT_HOME'] : path.join(home, '.copilot'), 'mcp-config.json');
  const never = (): boolean => false;
  const user = foldLayers([layer(userFile)], o, never);
  const workspace = foldLayers(
    workspaceDirs(cwd).reverse().flatMap((d) => [layer(path.join(d, '.mcp.json')), layer(path.join(d, '.github', 'mcp.json'))]),
    o,
    never,
  );
  const conflict = user.conflict ?? workspace.conflict;
  return {
    present: user.present || (env['COPILOT_ALLOW_ALL'] === 'true' && workspace.present),
    overridden: [],
    ...(conflict ? { conflict } : {}),
  };
}
