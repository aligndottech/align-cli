import { alignServerEntry } from '../../mcp-setup.js';
import type { ConfigWrite } from '../config-writes.js';
import { COPY_PREFIX, type GeminiProjectState } from '../gemini-state.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface GeminiLaunchContext extends Pick<LaunchContext, 'passthrough' | 'cachePath'>, GeminiProjectState {}

/** Same reason as the Claude adapter: never shadow a user's own `align` server. */
const INJECTED_SERVER_NAME = 'align-local';

export const GEMINI_TRUST_NOTE = "Gemini turns off MCP servers, Align's included, in folders you haven't trusted. Trust this folder in Gemini to use the graph here.";

/**
 * Gemini CLI, written ONCE (gemini 0.63.0): the `align-local` entry goes into the user's
 * settings file by the safe writer, with a backup and an exact `align use --undo`.
 *
 * Not per session. The first design pointed GEMINI_CLI_SYSTEM_SETTINGS_PATH at a copy in the
 * launch cache, and Gemini 0.63.0 skips any system settings file unless the file and every
 * directory above it is root-owned and not group/other writable (gemini-system-file.ts), so
 * Gemini users got no graph and only Gemini's own warning as a clue. A per-session
 * GEMINI_CLI_HOME was rejected too: it would have to mirror the user's whole ~/.gemini (oauth
 * credentials, history, trusted folders, extensions) and anything Gemini writes there during
 * the session, a changed theme or a first login, would be lost with the session directory.
 *
 * Nothing else changes: no flags, no GEMINI_CLI_* variable (so a repo .env cannot substitute
 * one either), no --skip-trust. Trust: Gemini turns off every MCP server in a folder it does
 * not trust. align says so in one line and never trusts a folder for the user.
 * Instructions come from the managed GEMINI.md block. Pass-through args are the whole of the args.
 */
export function buildGeminiLaunch(c: GeminiLaunchContext): LaunchSpec {
  const writes: ConfigWrite[] = [];
  const notes: string[] = [];
  if (c.conflict) {
    notes.push(`${c.conflict} defines its own align-local MCP server, so Align did not add its graph to Gemini. Remove that entry to use the graph.`);
  } else if (!c.present) {
    writes.push({
      kind: 'mcp-entry',
      file: c.settingsFile,
      topKey: 'mcpServers',
      name: INJECTED_SERVER_NAME,
      entry: alignServerEntry('mcpServers', 'local'),
      invalidJsonAdvice: ' (Gemini accepts comments in this file and align does not, so remove any comments or fix the syntax), then run align again',
    });
  }
  if (c.trust === 'untrusted' || c.trust === 'unknown') notes.push(GEMINI_TRUST_NOTE);
  return {
    bin: 'gemini',
    args: [...c.passthrough],
    env: { ALIGN_WRAPPED: '1' },
    files: [],
    // Ages out the system-settings copies earlier align versions left in the cache.
    prune: { prefix: COPY_PREFIX },
    ...(writes.length > 0 ? { writes } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}
