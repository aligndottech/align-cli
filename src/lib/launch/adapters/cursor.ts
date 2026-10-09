import { alignServerEntry } from '../../mcp-setup.js';
import type { ConfigWrite } from '../config-writes.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface CursorLaunchContext extends Pick<LaunchContext, 'passthrough'> {
  projectHasMcp: boolean;
  /** ~/.cursor/mcp.json. */
  mcpFile: string;
}

const INJECTED_SERVER_NAME = 'align-local';

/**
 * Cursor CLI (`cursor-agent`; the docs call the command `agent`, which is not run on a guess) has no per-session input for MCP
 * servers, so the `align-local` entry is written ONCE into the user's global ~/.cursor/mcp.json
 * by the safe writer, only when absent.
 *
 * No flags are injected. `--approve-mcps` exists but approves EVERY unapproved MCP server for
 * the session, the user's own included, which is not ours to decide; the user approves
 * align-local once (the hint below). No hooks are written either: Cursor's hooks docs confirm
 * only `workspaceOpen` for the CLI (see config-writes.ts). Pass-through args are the whole of the args.
 */
export function buildCursorLaunch(c: CursorLaunchContext): LaunchSpec {
  const writes: ConfigWrite[] = [];
  if (!c.projectHasMcp) {
    writes.push({
      kind: 'mcp-entry',
      file: c.mcpFile,
      topKey: 'mcpServers',
      name: INJECTED_SERVER_NAME,
      entry: alignServerEntry('mcpServers', 'local'),
      hint: 'Cursor asks before it loads a new MCP server. Approve it once: cursor-agent mcp enable align-local',
    });
  }
  return { bin: 'cursor-agent', args: [...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [], ...(writes.length > 0 ? { writes } : {}) };
}
