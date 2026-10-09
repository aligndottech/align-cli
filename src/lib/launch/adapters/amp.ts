import { alignServerEntry } from '../../mcp-setup.js';
import type { AmpProjectState } from '../amp-state.js';
import type { ConfigWrite } from '../config-writes.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface AmpLaunchContext extends Pick<LaunchContext, 'passthrough'>, AmpProjectState {}

const INJECTED_SERVER_NAME = 'align-local';

/**
 * Amp, written ONCE (amp 0.0.1791576029): align-local goes into the user's settings file under
 * `amp.mcpServers` through the safe writer, once, with an exact `align use --undo`.
 *
 * Not `--mcp-config`, though Amp has it: Amp writes whatever that flag brought in back into the
 * user's settings on `amp mcp add/remove` (tagged `"_target": "flag"`), where undo cannot see it.
 * Verified in a sandbox: after align's write, `amp mcp add zz` keeps align-local as written, so
 * undo takes out align-local and leaves Amp's own change.
 *
 * A settings file with comments is never rewritten (JSON serialising would drop them): one line
 * with Amp's own command to add the server instead. Instructions come from AGENTS.md.
 */
export function buildAmpLaunch(c: AmpLaunchContext): LaunchSpec {
  const writes: ConfigWrite[] = [];
  const notes: string[] = [];
  if (c.conflict) {
    notes.push(`${c.conflict} defines its own align-local MCP server, so Align did not add its graph to Amp. Remove that entry to use the graph.`);
  } else if (!c.present && c.commented) {
    notes.push(`${c.settingsFile} has comments, and Align does not rewrite a file it would strip them from. Add the graph yourself: amp mcp add align-local -- align mcp --env local`);
  } else if (!c.present) {
    writes.push({ kind: 'mcp-entry', file: c.settingsFile, topKey: 'amp.mcpServers', name: INJECTED_SERVER_NAME, entry: alignServerEntry('mcpServers', 'local') });
  }
  return { bin: 'amp', args: [...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [], ...(writes.length > 0 ? { writes } : {}), ...(notes.length > 0 ? { notes } : {}) };
}
