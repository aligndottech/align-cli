import { alignServerEntry } from '../../mcp-setup.js';
import { geminiCopyName, type GeminiProjectState } from '../gemini-state.js';
import { geminiSystemDefaultsPath } from '../gemini-trust.js';
import { parseJsonc } from '../strict-entry.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface GeminiLaunchContext extends Pick<LaunchContext, 'passthrough' | 'cachePath'>, GeminiProjectState {
  /** The environment the child will inherit: the user's own GEMINI_CLI_* are read from here. */
  env: Record<string, string | undefined>;
  platform: string;
}

/** Same reason as the Claude adapter: never shadow a user's own `align` server. */
const INJECTED_SERVER_NAME = 'align-local';

export const GEMINI_TRUST_NOTE = "Gemini turns off MCP servers, Align's included, in folders you haven't trusted. Trust this folder in Gemini to use the graph here.";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The system settings (JSONC, as Gemini reads them) as an object we can add to, or null when we must not touch them. */
function parseTheirs(text: string | null): Json | null {
  if (text === null) return {};
  const parsed = parseJsonc(text);
  if (!parsed) return null;
  if (parsed['mcpServers'] !== undefined && !isObject(parsed['mcpServers'])) return null;
  return parsed;
}

/**
 * Gemini CLI, per session, nothing written to the user's own config (gemini 0.58.0):
 * GEMINI_CLI_SYSTEM_SETTINGS_PATH names the system settings file, and Gemini MERGES its
 * mcpServers with the user's (verified: `gemini mcp list` shows both). That variable REPLACES
 * the system file Gemini would otherwise read (the user's own value, or the platform default an
 * admin may have filled), so align points it at a COPY of that file with align-local added,
 * never at a file of align's alone. Gemini also derives system-defaults.json from that file's
 * directory, so the original location is pinned with GEMINI_CLI_SYSTEM_DEFAULTS_PATH unless the
 * user set it. A system file align cannot read or parse is never replaced: no injection, and
 * one line saying why (the same rule as OpenCode's OPENCODE_CONFIG_CONTENT).
 *
 * Trust: Gemini turns off every MCP server in a folder it does not trust. align says so in one
 * line and never trusts a folder for the user (no --skip-trust, no GEMINI_CLI_TRUST_WORKSPACE).
 * Instructions come from the managed GEMINI.md block. Pass-through args are the whole of the args.
 */
export function buildGeminiLaunch(c: GeminiLaunchContext): LaunchSpec {
  const env: Record<string, string> = { ALIGN_WRAPPED: '1' };
  const files: LaunchSpec['files'] = [];
  const notes: string[] = [];
  const copy = geminiCopyName(c.systemSettings.path);
  let injected = false;

  if (c.overridden.length > 0 || !c.present) {
    const theirs = c.systemSettings.unreadable ? null : parseTheirs(c.systemSettings.text);
    if (!theirs) {
      notes.push(`Gemini's system settings file ${c.systemSettings.path} is not readable JSON with an object "mcpServers", so Align's graph tools were not added to this session. Fix the file, or point GEMINI_CLI_SYSTEM_SETTINGS_PATH at one that is.`);
    } else {
      // Set unconditionally: a canonical align-local here would have made `present` true with
      // nothing overridden, so whatever is under this name now is replaced by ours.
      const merged = { ...theirs, mcpServers: { ...((theirs['mcpServers'] as Json | undefined) ?? {}), [INJECTED_SERVER_NAME]: alignServerEntry('mcpServers', 'local') } };
      // 0600: the copy carries whatever the admin's system file holds.
      files.push({ name: copy, content: `${JSON.stringify(merged, null, 2)}\n`, mode: 0o600 });
      env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'] = c.cachePath(copy);
      if (!c.env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']) env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] = geminiSystemDefaultsPath(c.systemSettings.path, c.platform);
      if (c.overridden.length > 0) notes.push(`Gemini will use Align's own align-local MCP server this session, not the one in ${c.overridden.join(', ')}.`);
      injected = true;
    }
  }
  if (c.trust === 'untrusted' || c.trust === 'unknown') notes.push(GEMINI_TRUST_NOTE);
  return {
    bin: 'gemini',
    args: [...c.passthrough],
    env,
    files,
    // Not injecting: a copy from an earlier launch must not linger with the admin's settings in it.
    ...(injected ? {} : { remove: [copy] }),
    ...(notes.length > 0 ? { notes } : {}),
  };
}
