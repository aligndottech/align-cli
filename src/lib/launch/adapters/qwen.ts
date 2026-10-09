import { alignServerEntry } from '../../mcp-setup.js';
import { QWEN_COPY_PREFIX, qwenCopyName, type QwenProjectState } from '../qwen-state.js';
import { qwenSystemDefaultsPath } from '../qwen-trust.js';
import { parseJsonc } from '../strict-entry.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface QwenLaunchContext extends Pick<LaunchContext, 'passthrough' | 'cachePath'>, QwenProjectState {
  /** The environment the child will inherit: the user's own QWEN_CODE_* are read from here. */
  env: Record<string, string | undefined>;
  platform: string;
}

/** Same reason as the Claude adapter: never shadow a user's own `align` server. */
const INJECTED_SERVER_NAME = 'align-local';

export const QWEN_TRUST_NOTE = "Qwen Code turns off MCP servers, Align's included, in folders you haven't trusted. Trust this folder in Qwen Code to use the graph here.";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseTheirs(text: string | null): Json | null {
  if (text === null) return {};
  const parsed = parseJsonc(text);
  if (!parsed) return null;
  if (parsed['mcpServers'] !== undefined && !isObject(parsed['mcpServers'])) return null;
  return parsed;
}

/**
 * Qwen Code, per session, nothing written to the user's own config (qwen-code 0.25.0, a Gemini
 * CLI fork with the same mechanism): QWEN_CODE_SYSTEM_SETTINGS_PATH names the system settings
 * file, read LAST and merged shallowly, so align points it at a 0600 COPY of the file Qwen would
 * otherwise read with align-local added (verified: `qwen mcp list` then shows the user's servers
 * and align-local, and align's entry replaces a user or workspace align-local whole). The
 * original system-defaults location is pinned with QWEN_CODE_SYSTEM_DEFAULTS_PATH unless the
 * user set it. A system file align cannot read or parse is never replaced: no injection, one line.
 *
 * Not `--mcp-config`: Qwen has one, but how it ranks against a same-named server in a settings
 * layer was not established, and the system tier's rank was.
 *
 * Trust: off by default in Qwen; when on, an untrusted folder gets MCP turned off, and align says
 * so in one line. It never trusts a folder for the user. Pass-through args are the whole of the args.
 */
export function buildQwenLaunch(c: QwenLaunchContext): LaunchSpec {
  const env: Record<string, string> = { ALIGN_WRAPPED: '1' };
  const files: LaunchSpec['files'] = [];
  const notes: string[] = [];
  const copy = qwenCopyName(c.systemSettings.path);
  let injected = false;

  if (c.overridden.length > 0 || !c.present) {
    const theirs = c.systemSettings.unreadable ? null : parseTheirs(c.systemSettings.text);
    if (!theirs) {
      notes.push(`Qwen Code's system settings file ${c.systemSettings.path} is not readable JSON with an object "mcpServers", so Align's graph tools were not added to this session. Fix the file, or point QWEN_CODE_SYSTEM_SETTINGS_PATH at one that is.`);
    } else {
      const merged = { ...theirs, mcpServers: { ...((theirs['mcpServers'] as Json | undefined) ?? {}), [INJECTED_SERVER_NAME]: alignServerEntry('mcpServers', 'local') } };
      files.push({ name: copy, content: `${JSON.stringify(merged, null, 2)}\n`, mode: 0o600 });
      env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = c.cachePath(copy);
      if (!c.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH']) env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] = qwenSystemDefaultsPath(c.systemSettings.path, c.platform);
      if (c.overridden.length > 0) notes.push(`Qwen Code will use Align's own align-local MCP server this session, not the one in ${c.overridden.join(', ')}.`);
      injected = true;
    }
  }
  if (c.trust === 'untrusted' || c.trust === 'unknown') notes.push(QWEN_TRUST_NOTE);
  return {
    bin: 'qwen',
    args: [...c.passthrough],
    env,
    files,
    prune: { prefix: QWEN_COPY_PREFIX, ...(injected ? { keep: copy } : { remove: copy }) },
    ...(notes.length > 0 ? { notes } : {}),
  };
}
