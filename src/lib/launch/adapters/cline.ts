import { alignServerEntry } from '../../mcp-setup.js';
import type { ClineProjectState } from '../cline-state.js';
import type { ConfigWrite } from '../config-writes.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface ClineLaunchContext extends Pick<LaunchContext, 'passthrough'>, ClineProjectState {}

const INJECTED_SERVER_NAME = 'align-local';

/**
 * Cline CLI, written ONCE (cline 3.0.70): align-local goes into its MCP settings file through the
 * safe writer, once, with an exact `align use --undo`. The flat `{command, args}` entry loads
 * (checked with `cline config --json`).
 *
 * Not CLINE_MCP_SETTINGS_PATH pointed at a copy: a `cline mcp add` during the session would land
 * in the copy and be lost. Never `--config`: that directory also holds the user's auth. No flag
 * is injected, so Cline's own approval settings stay the user's.
 */
export function buildClineLaunch(c: ClineLaunchContext): LaunchSpec {
  const writes: ConfigWrite[] = [];
  const notes: string[] = [];
  if (c.conflict) {
    notes.push(`${c.conflict} defines its own align-local MCP server, so Align did not add its graph to Cline. Remove that entry to use the graph.`);
  } else if (!c.present) {
    writes.push({ kind: 'mcp-entry', file: c.mcpFile, topKey: 'mcpServers', name: INJECTED_SERVER_NAME, entry: alignServerEntry('mcpServers', 'local') });
  }
  return { bin: 'cline', args: [...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [], ...(writes.length > 0 ? { writes } : {}), ...(notes.length > 0 ? { notes } : {}) };
}
