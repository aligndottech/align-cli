import { alignServerEntry } from '../../mcp-setup.js';
import type { ConfigWrite } from '../config-writes.js';
import type { GrokProjectState } from '../grok-state.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface GrokLaunchContext extends Pick<LaunchContext, 'passthrough'>, GrokProjectState {}

const INJECTED_SERVER_NAME = 'align-local';

/**
 * Grok Build (xAI's `grok`), written ONCE: grok 1.0.50 has no per-session MCP input (no flag in
 * its CLI source; the GROK_CONFIG overlay is allowlisted and excludes `mcp_servers`), so the
 * `[mcp_servers.align-local]` table is appended once to `$GROK_HOME/config.toml` inside an
 * align-owned marked block, by the safe writer, with an exact `align use --undo` (verified in a
 * sandbox: `grok mcp list` then shows the user's servers and align-local).
 *
 * No flags are injected: no `--trust`, Grok's folder trust stays the user's decision.
 * Instructions come from AGENTS.md / CLAUDE.md, which Grok reads.
 */
export function buildGrokLaunch(c: GrokLaunchContext): LaunchSpec {
  const writes: ConfigWrite[] = [];
  const notes: string[] = [];
  if (c.conflict) {
    notes.push(`${c.conflict} defines its own align-local MCP server, so Align did not add its graph to Grok Build. Remove that entry to use the graph.`);
  } else if (!c.present) {
    const { command, args } = alignServerEntry('mcpServers', 'local') as { command: string; args: string[] };
    writes.push({ kind: 'toml-mcp-entry', file: c.configFile, topKey: 'mcp_servers', name: INJECTED_SERVER_NAME, entry: { command, args } });
  }
  return { bin: 'grok', args: [...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [], ...(writes.length > 0 ? { writes } : {}), ...(notes.length > 0 ? { notes } : {}) };
}
