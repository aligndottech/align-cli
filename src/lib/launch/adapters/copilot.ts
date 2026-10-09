import { alignServerEntry } from '../../mcp-setup.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface CopilotLaunchContext extends Pick<LaunchContext, 'passthrough' | 'cachePath'> {
  /** Copilot would already start a local align server (align-local, or align at --env local). */
  projectHasMcp: boolean;
}

/** Same reason as the Claude adapter: never shadow a user's own `align` server. */
const INJECTED_SERVER_NAME = 'align-local';
const MCP_FILE = 'copilot-mcp.json';

/**
 * GitHub Copilot CLI, per session, nothing written to the user's own config (copilot 1.0.95,
 * `copilot --help`): `--additional-mcp-config <json>` takes "JSON string or file path (prefix
 * with @) ... augments config from ~/.copilot/mcp-config.json for this session". So align-local
 * goes in a launch file and the user's own servers still load. COPILOT_HOME is never set: that
 * dir also holds the user's auth.
 *
 * ORDER: the flag goes FIRST. It is a root option: `copilot --additional-mcp-config @f mcp list`
 * is accepted and `copilot mcp list --additional-mcp-config @f` is refused by the subcommand
 * (both checked on 1.0.95), and in front it can never land after a user's `--`.
 */
export function buildCopilotLaunch(c: CopilotLaunchContext): LaunchSpec {
  const injected: string[] = [];
  const files: LaunchSpec['files'] = [];
  if (!c.projectHasMcp) {
    files.push({ name: MCP_FILE, content: `${JSON.stringify({ mcpServers: { [INJECTED_SERVER_NAME]: alignServerEntry('copilot', 'local') } }, null, 2)}\n` });
    injected.push('--additional-mcp-config', `@${c.cachePath(MCP_FILE)}`);
  }
  return { bin: 'copilot', args: [...injected, ...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files };
}
