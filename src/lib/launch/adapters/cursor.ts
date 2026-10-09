import { alignServerEntry } from '../../mcp-setup.js';
import type { ConfigWrite } from '../config-writes.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface CursorLaunchContext extends Pick<LaunchContext, 'passthrough'> {
  projectHasMcp: boolean;
  hooksPresent: boolean;
  /** ~/.cursor/mcp.json and ~/.cursor/hooks.json. */
  mcpFile: string;
  hooksFile: string;
}

const INJECTED_SERVER_NAME = 'align-local';

/**
 * Cursor CLI (`cursor-agent`) has no per-session input for MCP servers or hooks, so both are
 * written ONCE into the user's global ~/.cursor files by the safe writer, each only when absent.
 * No flags are injected. `--approve-mcps` exists but approves EVERY unapproved MCP server for
 * the session, the user's own included, which is not ours to decide: the user approves
 * align-local once, in Cursor. Pass-through args are the whole of the args.
 */
export function buildCursorLaunch(c: CursorLaunchContext): LaunchSpec {
  const writes: ConfigWrite[] = [];
  if (!c.projectHasMcp) {
    writes.push({ kind: 'mcp-entry', file: c.mcpFile, topKey: 'mcpServers', name: INJECTED_SERVER_NAME, entry: alignServerEntry('mcpServers', 'local') });
  }
  if (!c.hooksPresent) writes.push({ kind: 'cursor-hooks', file: c.hooksFile });
  return {
    bin: 'cursor-agent',
    args: [...c.passthrough],
    env: { ALIGN_WRAPPED: '1' },
    files: [],
    ...(writes.length > 0 ? { writes } : {}),
  };
}
