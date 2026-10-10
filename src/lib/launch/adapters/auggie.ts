import { alignServerEntry } from '../../mcp-setup.js';
import type { AuggieProjectState } from '../auggie-state.js';
import type { ConfigWrite } from '../config-writes.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface AuggieLaunchContext extends Pick<LaunchContext, 'passthrough'>, AuggieProjectState {}

const INJECTED_SERVER_NAME = 'align-local';

/**
 * Auggie, written ONCE (auggie 0.36.0): align-local goes into the user settings file under
 * `mcpServers` through the safe writer, once, with an exact `align use --undo`.
 *
 * Not `--mcp-config`, though Auggie has it: its help says it "Overwrites default mcp
 * configuration in settings.json", and in its bundle the settings servers are not read at all
 * when the flag is given. The user's own servers would vanish for the session.
 *
 * A commented settings file is never rewritten: one line with Auggie's own command instead. No
 * flag is injected: no `--permission`, no `--allow-indexing`; Auggie's own prompts stay the
 * user's. Instructions come from AGENTS.md.
 */
export function buildAuggieLaunch(c: AuggieLaunchContext): LaunchSpec {
  const writes: ConfigWrite[] = [];
  const notes: string[] = [];
  if (c.conflict) {
    notes.push(`${c.conflict} defines its own align-local MCP server, so Align did not add its graph to Auggie. Remove that entry to use the graph.`);
  } else if (!c.present && c.commented) {
    notes.push(`${c.settingsFile} has comments, and Align does not rewrite a file it would strip them from. Add the graph yourself: auggie mcp add align-local --command align --args "mcp --env local"`);
  } else if (!c.present) {
    writes.push({ kind: 'mcp-entry', file: c.settingsFile, topKey: 'mcpServers', name: INJECTED_SERVER_NAME, entry: alignServerEntry('mcpServers', 'local') });
  }
  // The user's own --mcp-config replaces the settings servers for this session (see above), so
  // whatever is in the settings file, the graph is not loaded. Say so; the file is left as it is.
  if (c.passthrough.some((a) => a === '--mcp-config' || a.startsWith('--mcp-config='))) {
    notes.push("--mcp-config replaces the MCP servers in Auggie's settings for this session, so Align's graph is not loaded. Add align-local to that config to use it here.");
  }
  return { bin: 'auggie', args: [...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [], ...(writes.length > 0 ? { writes } : {}), ...(notes.length > 0 ? { notes } : {}) };
}
