import { alignServerEntry } from '../../mcp-setup.js';
import type { ConfigWrite } from '../config-writes.js';
import { withInjectedFlags } from './args.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface CursorLaunchContext extends Pick<LaunchContext, 'passthrough'> {
  hasAlignLocalEntry: boolean;
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
 * `--approve-mcps` (cursor.com/docs/cli/mcp: "Auto-approve all MCP servers (skip approval
 * prompts)") is passed only when the entry is ours, so a user whose only align server is their
 * own is not opted into blanket approval by us. It still covers their other servers for that run:
 * the flag has no per-server form. Pass-through args first.
 */
export function buildCursorLaunch(c: CursorLaunchContext): LaunchSpec {
  const writes: ConfigWrite[] = [];
  if (!c.projectHasMcp) {
    writes.push({ kind: 'mcp-entry', file: c.mcpFile, topKey: 'mcpServers', name: INJECTED_SERVER_NAME, entry: alignServerEntry('mcpServers', 'local') });
  }
  if (!c.hooksPresent) writes.push({ kind: 'cursor-hooks', file: c.hooksFile });
  const ours = !c.projectHasMcp || c.hasAlignLocalEntry;
  return {
    bin: 'cursor-agent',
    args: withInjectedFlags(c.passthrough, ours ? ['--approve-mcps'] : []),
    env: { ALIGN_WRAPPED: '1' },
    files: [],
    ...(writes.length > 0 ? { writes } : {}),
  };
}
