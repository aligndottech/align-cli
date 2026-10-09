import { alignNudgeBody } from '../../agent-rules.js';
import { alignServerEntry } from '../../mcp-setup.js';
import type { DroidProjectState } from '../droid-state.js';
import type { LaunchContext, LaunchFile, LaunchSpec } from './claude-code.js';

export interface DroidLaunchContext extends Pick<LaunchContext, 'passthrough' | 'cachePath'>, DroidProjectState {}

/** Same reason as the Claude adapter: never shadow a user's own `align` server. */
const INJECTED_SERVER_NAME = 'align-local';
const SETTINGS_FILE = 'droid-settings.json';

/**
 * Factory Droid, per session, nothing written to the user's own config (droid 0.237.0):
 * `--settings <path>` is a "runtime settings file merged for this process only", and its `mcp`
 * key takes the mcp.json shape. Droid lists that server as `[runtime]` beside the user's own,
 * and the runtime definition wins a same-named one (verified with `droid --settings f mcp list`).
 * The instructions go in with `--append-system-prompt-file` unless an AGENTS.md already holds them.
 *
 * A user who runs Droid with their own runtime settings keeps them: Droid takes one, so align
 * adds no second file and says so in one line.
 *
 * ORDER: our flags go FIRST. They are root options (`droid --settings f mcp list` is accepted),
 * so in front they apply to a bare session and to `exec`, and never land after a user's `--`.
 */
export function buildDroidLaunch(c: DroidLaunchContext): LaunchSpec {
  const injected: string[] = [];
  const files: LaunchFile[] = [];
  const notes: string[] = [];
  if (c.ownSettings !== undefined) {
    notes.push(`Droid is using your own runtime settings (${c.ownSettings}), so Align did not add its graph tools to this session.`);
  } else if (c.overridden.length > 0 || !c.present) {
    files.push({ name: SETTINGS_FILE, content: `${JSON.stringify({ mcp: { mcpServers: { [INJECTED_SERVER_NAME]: alignServerEntry('vscode', 'local') } } }, null, 2)}\n` });
    injected.push('--settings', c.cachePath(SETTINGS_FILE));
    if (c.overridden.length > 0) notes.push(`Droid will use Align's own align-local MCP server this session, not the one in ${c.overridden.join(', ')}.`);
  }
  if (!c.projectHasBlock) {
    files.push({ name: 'align-instructions.md', content: `${alignNudgeBody()}\n` });
    injected.push('--append-system-prompt-file', c.cachePath('align-instructions.md'));
  }
  return { bin: 'droid', args: [...injected, ...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files, ...(notes.length > 0 ? { notes } : {}) };
}
