import { alignNudgeBody, piExtensionBody } from '../../agent-rules.js';
import { alignServerEntry } from '../../mcp-setup.js';
import type { ConfigWrite } from '../config-writes.js';
import { withInjectedFlags } from './args.js';
import type { LaunchContext, LaunchFile, LaunchSpec } from './claude-code.js';

export interface PiLaunchContext extends Pick<LaunchContext, 'passthrough' | 'cachePath' | 'projectHasBlock'> {
  /** The project (or pi's own extensions dir) already runs the align extension against the local graph. */
  projectHasExtension: boolean;
  projectHasMcp: boolean;
  /** <agentDir>/mcp.json. The entry is added here once, unless it is a symlink (the writer refuses those). */
  mcpFile: string;
}

/** Same reason as the Claude adapter: never shadow a user's own `align` server. */
const INJECTED_SERVER_NAME = 'align-local';
const EXTENSION_FILE = 'pi-align.ts';

/**
 * pi, per session where it can be (spike S5, pi 0.84.4):
 *  - the pre/post-edit check is the SAME extension text the project writer produces, loaded
 *    with `-e` (repeatable; explicit -e survives --no-extensions);
 *  - the instruction text goes in with --append-system-prompt (it takes a file path);
 *  - pi has no per-session MCP input, so the `align-local` entry is added ONCE to
 *    <agentDir>/mcp.json by the safe writer. PI_CODING_AGENT_DIR is never redirected: that dir
 *    holds auth.json and the session history.
 * Each injection is skipped when pi would already load it. Pass-through args first.
 */
export function buildPiLaunch(c: PiLaunchContext): LaunchSpec {
  const injected: string[] = [];
  const files: LaunchFile[] = [];
  const writes: ConfigWrite[] = [];
  if (!c.projectHasExtension) {
    files.push({ name: EXTENSION_FILE, content: piExtensionBody('local') });
    injected.push('-e', c.cachePath(EXTENSION_FILE));
  }
  if (!c.projectHasBlock) {
    files.push({ name: 'align-instructions.md', content: `${alignNudgeBody()}\n` });
    injected.push('--append-system-prompt', c.cachePath('align-instructions.md'));
  }
  if (!c.projectHasMcp) {
    writes.push({ kind: 'mcp-entry', file: c.mcpFile, topKey: 'mcpServers', name: INJECTED_SERVER_NAME, entry: alignServerEntry('pi', 'local') });
  }
  return { bin: 'pi', args: withInjectedFlags(c.passthrough, injected), env: { ALIGN_WRAPPED: '1' }, files, ...(writes.length > 0 ? { writes } : {}) };
}
