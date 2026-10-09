import { alignServerEntry } from '../../mcp-setup.js';
import type { AlignLocalState } from '../strict-entry.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface CodexLaunchContext extends Pick<LaunchContext, 'passthrough'>, AlignLocalState {}

/** Same reason as the Claude adapter: never shadow a user's own `align` server. */
const INJECTED_SERVER_NAME = 'align-local';

/**
 * A TOML literal string. Single quotes, not JSON's double quotes: on Windows an npm `codex.cmd`
 * runs through cmd.exe, and runAgent refuses any arg holding `"`. A literal string has no
 * escapes, so a value holding `'` or a newline cannot be written this way; ours never do.
 */
function tomlLiteral(value: string): string {
  if (/['\n\r]/.test(value)) throw new Error(`cannot pass ${JSON.stringify(value)} to codex -c as a TOML literal string`);
  return `'${value}'`;
}

/**
 * Codex, per session, nothing written to the user's own config (codex-cli 0.153.0):
 * `-c key=value` overrides one config value for this run, parsed as TOML, and leaves every
 * other `mcp_servers` table in place. So align-local is two overrides, and the user's own
 * servers still load beside it (verified with `codex -c ... mcp list`).
 *
 * ORDER: our -c flags go FIRST. `-c` is a root option, and codex reads root options before the
 * `[PROMPT]` or `<COMMAND>` that follows them, so in front it applies to a bare session, to
 * `exec`, `resume` and every other subcommand, and it can never land after a user's `--`, where
 * it would be read as a prompt.
 */
export function buildCodexLaunch(c: CodexLaunchContext): LaunchSpec {
  const injected: string[] = [];
  const notes: string[] = [];
  if (c.conflict) {
    // -c can set keys but never remove one: injecting would launch a merged, repo-shaped server.
    notes.push(`${c.conflict} redefines the align-local MCP server, so Align's graph is off for this Codex session. Remove that entry to use the graph here.`);
  } else if (c.overridden.length > 0 || !c.present) {
    const { command, args } = alignServerEntry('mcpServers', 'local') as { command: string; args: string[] };
    const key = `mcp_servers.${INJECTED_SERVER_NAME}`;
    injected.push('-c', `${key}.command=${tomlLiteral(command)}`, '-c', `${key}.args=[${args.map(tomlLiteral).join(',')}]`);
    if (c.overridden.length > 0) {
      // The table holds only command/args/enabled, so these three overrides replace all of it.
      injected.push('-c', `${key}.enabled=true`);
      notes.push(`Replaced the align-local MCP server in ${c.overridden.join(', ')} with Align's own for this Codex session.`);
    }
  }
  return { bin: 'codex', args: [...injected, ...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [], ...(notes.length > 0 ? { notes } : {}) };
}
