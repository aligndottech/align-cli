import { alignServerEntry } from '../../mcp-setup.js';
import type { ConfigWrite } from '../config-writes.js';
import type { KiroProjectState } from '../kiro-state.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface KiroLaunchContext extends Pick<LaunchContext, 'passthrough'>, KiroProjectState {}

const INJECTED_SERVER_NAME = 'align-local';

/**
 * Kiro CLI, written ONCE, from its docs only: no per-session MCP input is documented, so the
 * `align-local` entry goes into the user's global `~/.kiro/settings/mcp.json` by the safe writer,
 * once, with an exact `align use --undo`.
 *
 * Deliberately NOT a custom agent file launched with `--agent`: an agent file declares its own
 * tools, and whether it keeps the user's own MCP servers and default tools could not be checked
 * against a binary (no npm package; the installer is a script, which align never runs). An agent
 * that silently hid the user's tools would be worse than none. No flags are injected: no
 * `--trust-all-tools`, Kiro's own approval stays the user's. Instructions come from AGENTS.md.
 */
export function buildKiroLaunch(c: KiroLaunchContext): LaunchSpec {
  const writes: ConfigWrite[] = [];
  const notes: string[] = [];
  if (c.conflict) {
    notes.push(`${c.conflict} defines its own align-local MCP server, so Align did not add its graph to Kiro. Remove that entry to use the graph.`);
  } else if (!c.present) {
    writes.push({ kind: 'mcp-entry', file: c.mcpFile, topKey: 'mcpServers', name: INJECTED_SERVER_NAME, entry: alignServerEntry('mcpServers', 'local') });
  }
  return { bin: 'kiro-cli', args: [...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [], ...(writes.length > 0 ? { writes } : {}), ...(notes.length > 0 ? { notes } : {}) };
}
