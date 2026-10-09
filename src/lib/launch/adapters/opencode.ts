import { alignNudgeBody, openCodePluginBody } from '../../agent-rules.js';
import { alignServerEntry } from '../../mcp-setup.js';
import type { LaunchContext, LaunchFile, LaunchSpec } from './claude-code.js';

export interface OpenCodeLaunchContext extends Pick<LaunchContext, 'passthrough' | 'cachePath'> {
  /** The environment the child will inherit: the user's own OPENCODE_CONFIG_* are read from here. */
  env: Record<string, string | undefined>;
  /** The project (or the user's global OpenCode config) already runs the align plugin against the local graph. */
  projectHasPlugin: boolean;
  projectHasMcp: boolean;
  projectHasBlock: boolean;
}

/** Same reason as the Claude adapter: never shadow a user's own `align` server (prod or team graph). */
const INJECTED_SERVER_NAME = 'align-local';
const PLUGIN_FILE = 'opencode-config/plugins/align.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The user's own OPENCODE_CONFIG_CONTENT as an object we can add to, or null when we must not touch it. */
function parseTheirs(raw: string | undefined): Json | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    if (parsed['mcp'] !== undefined && !isObject(parsed['mcp'])) return null;
    if (parsed['instructions'] !== undefined && !Array.isArray(parsed['instructions'])) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * OpenCode, per session, nothing written to the user's own config (spike S4, opencode 1.18.27):
 *  - MCP and instructions travel in OPENCODE_CONFIG_CONTENT, which OpenCode reads as inline
 *    config above the project config.
 *  - The pre/post-edit plugin loads from <OPENCODE_CONFIG_DIR>/plugins/, pointed at a cached dir.
 *    There is one such dir, so a user's own OPENCODE_CONFIG_DIR is never replaced: we skip the
 *    plugin rather than swap their config dir out from under them.
 * Each injection is skipped when the project already carries it. Pass-through args go first;
 * OpenCode needs no flags, so they are also all of the args.
 */
export function buildOpenCodeLaunch(c: OpenCodeLaunchContext): LaunchSpec {
  const env: Record<string, string> = { ALIGN_WRAPPED: '1' };
  const files: LaunchFile[] = [];
  const ours: Json = {};

  if (!c.projectHasMcp) ours['mcp'] = { [INJECTED_SERVER_NAME]: alignServerEntry('opencode', 'local') };
  if (!c.projectHasBlock) {
    files.push({ name: 'align-instructions.md', content: `${alignNudgeBody()}\n` });
    ours['instructions'] = [c.cachePath('align-instructions.md')];
  }
  if (!c.projectHasPlugin && !c.env['OPENCODE_CONFIG_DIR']) {
    files.push({ name: PLUGIN_FILE, content: openCodePluginBody('local') });
    env['OPENCODE_CONFIG_DIR'] = c.cachePath('opencode-config');
  }

  const theirs = parseTheirs(c.env['OPENCODE_CONFIG_CONTENT']);
  const notes: string[] = [];
  if (!theirs && Object.keys(ours).length > 0) {
    notes.push('OPENCODE_CONFIG_CONTENT is set but is not usable JSON with object "mcp" and array "instructions", so Align\'s graph tools were not added to this session. Fix or unset it.');
  }
  if (theirs && Object.keys(ours).length > 0) {
    const merged: Json = { ...theirs };
    if (ours['mcp']) merged['mcp'] = { ...(theirs['mcp'] as Json | undefined), ...(ours['mcp'] as Json) };
    if (ours['instructions']) merged['instructions'] = [...((theirs['instructions'] as unknown[] | undefined) ?? []), ...(ours['instructions'] as string[])];
    env['OPENCODE_CONFIG_CONTENT'] = JSON.stringify(merged);
  }
  return { bin: 'opencode', args: [...c.passthrough], env, files, ...(notes.length > 0 ? { notes } : {}) };
}
