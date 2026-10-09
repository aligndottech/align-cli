import { alignServerEntry } from '../../mcp-setup.js';
import type { AmpProjectState } from '../amp-state.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface AmpLaunchContext extends Pick<LaunchContext, 'passthrough' | 'cachePath'>, AmpProjectState {}

/** Same reason as the Claude adapter: never shadow a user's own `align` server. */
const INJECTED_SERVER_NAME = 'align-local';
const MCP_FILE = 'amp-mcp.json';

/**
 * Amp, per session, nothing written to the user's own config (amp 0.0.1791576029): `--mcp-config`
 * takes "JSON configuration or file path for MCP servers to merge with existing settings", as a
 * bare `{ name: entry }` map (the `mcpServers` wrapper is refused). Verified with `amp
 * --mcp-config f mcp list`: the user's own servers are listed beside align-local, and a user
 * align-local is replaced. A workspace align-local is listed beside it instead, so that one is a
 * conflict (amp-state.ts). A user who passes their own `--mcp-config` keeps it, with one line.
 *
 * ORDER: the flag goes FIRST, a root option (`amp --mcp-config f mcp list` is accepted), so it
 * never lands after a user's `--`. Instructions come from AGENTS.md, which Amp reads.
 */
export function buildAmpLaunch(c: AmpLaunchContext): LaunchSpec {
  const injected: string[] = [];
  const files: LaunchSpec['files'] = [];
  const notes: string[] = [];
  if (c.conflict) {
    notes.push(`${c.conflict} redefines the align-local MCP server, so Align's graph is off for this Amp session. Remove that entry to use the graph here.`);
  } else if (c.ownMcpConfig !== undefined) {
    notes.push(`Amp is using your own --mcp-config (${c.ownMcpConfig}), so Align did not add its graph tools to this session.`);
  } else if (c.overridden.length > 0 || !c.present) {
    files.push({ name: MCP_FILE, content: `${JSON.stringify({ [INJECTED_SERVER_NAME]: alignServerEntry('mcpServers', 'local') }, null, 2)}\n` });
    injected.push('--mcp-config', c.cachePath(MCP_FILE));
    if (c.overridden.length > 0) notes.push(`Amp will use Align's own align-local MCP server this session, not the one in ${c.overridden.join(', ')}.`);
  }
  return { bin: 'amp', args: [...injected, ...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files, ...(notes.length > 0 ? { notes } : {}) };
}
