import { alignServerEntry } from '../../mcp-setup.js';
import type { ClineProjectState } from '../cline-state.js';
import type { ConfigWrite } from '../config-writes.js';
import { mcpChildEnv } from '../mcp-child-env.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface ClineLaunchContext extends Pick<LaunchContext, 'passthrough'>, ClineProjectState {
  /** The launcher's environment: the user's own values for the MCP child's env block. */
  env?: Record<string, string | undefined>;
  /** The file a launch without the one-session flag would use (for the note). */
  defaultMcpFile?: string;
}

const INJECTED_SERVER_NAME = 'align-local';

/**
 * Cline CLI, written ONCE (cline 3.0.70): align-local goes into its MCP settings file through the
 * safe writer, once, with an exact `align use --undo`. The flat `{command, args}` entry loads
 * (checked with `cline config --json`).
 *
 * A `--config` or `--data-dir` the user passes picks a directory for that session; align writes
 * nothing there (a permanent entry in a one-session directory), and says so.
 *
 * Not CLINE_MCP_SETTINGS_PATH pointed at a copy: a `cline mcp add` during the session would land
 * in the copy and be lost. Never `--config`: that directory also holds the user's auth. No flag
 * is injected, so Cline's own approval settings stay the user's.
 */
/** The note names the file the user's own default launch would get. */
const clineMcpFileDefault = (c: ClineLaunchContext): string => c.defaultMcpFile ?? c.mcpFile;

export function buildClineLaunch(c: ClineLaunchContext): LaunchSpec {
  const writes: ConfigWrite[] = [];
  const notes: string[] = [];
  if (c.conflict) {
    notes.push(`${c.conflict} defines its own align-local MCP server, so Align did not add its graph to Cline. Remove that entry to use the graph.`);
  } else if (!c.present && c.oneSession) {
    const flag = c.passthrough.some((a) => a === '--config' || a.startsWith('--config=')) ? '--config' : '--data-dir';
    notes.push(`Align does not add its graph to a Cline directory chosen for one session (${flag}). Run cline without it once, or add align-local to ${clineMcpFileDefault(c)} yourself.`);
  } else if (!c.present) {
    // With its env block: Cline's MCP children (spawned by its hub) inherit a repo `.env`.
    writes.push({ kind: 'mcp-entry', file: c.mcpFile, topKey: 'mcpServers', name: INJECTED_SERVER_NAME, entry: { ...alignServerEntry('mcpServers', 'local'), env: mcpChildEnv(c.env ?? {}) } });
  }
  return { bin: 'cline', args: [...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [], ...(writes.length > 0 ? { writes } : {}), ...(notes.length > 0 ? { notes } : {}) };
}
