import { alignServerEntry } from '../../mcp-setup.js';
import type { ContinueProjectState } from '../continue-state.js';
import { mcpChildEnv } from '../mcp-child-env.js';
import { unreadableNote } from './notes.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface ContinueLaunchContext extends Pick<LaunchContext, 'passthrough' | 'cachePath'>, ContinueProjectState {
  /** The launcher's environment: the user's own values for the MCP child's env block. */
  env?: Record<string, string | undefined>;
}

const FILE = 'continue-align-local.yaml';

/**
 * Continue CLI (`cn`), per session, nothing written to the user's config (cn 1.5.47): `--mcp`
 * takes a local block when the value is a path (`/`, `.`, `~` or `file://`), and cn merges it into
 * whatever config it loaded. Verified against a stub model: the request carried the user's server
 * and align-local. `file://` + the raw path is used because it is the form that also reads a
 * Windows path: cn's decodePackageIdentifier strips the first 7 characters of a `file://` value and
 * uses the rest as the path, so `file://C:\\...` gives `C:\\...`. pathToFileURL would give
 * `file:///C:/...`, which cn decodes to `/C:/...`, a path that does not exist on Windows.
 *
 * The flag goes first: `--mcp` is a root option, and cn accepted it in front of a subcommand
 * (`cn --mcp f ls --help`). When the loaded config.yaml already defines align-local, nothing is
 * added (canonical: no duplicate; anything else wins over ours, so one line says why). No
 * `--auto`/`--allow`: cn's own tool policy stays the user's.
 */
export function buildContinueLaunch(c: ContinueLaunchContext): LaunchSpec {
  const spec: LaunchSpec = { bin: 'cn', args: [...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [] };
  if (c.unreadable) {
    return { ...spec, notes: [unreadableNote(c.unreadable)] };
  }
  if (c.conflict) {
    return { ...spec, notes: [`${c.conflict} defines its own align-local MCP server, so Align did not add its graph to Continue CLI. Remove that entry to use the graph.`] };
  }
  if (c.present) return spec;
  const { command, args } = alignServerEntry('mcpServers', 'local') as { command: string; args: string[] };
  const content = [
    'name: align-local',
    'version: 0.0.1',
    'schema: v1',
    'mcpServers:',
    '  - name: align-local',
    `    command: ${JSON.stringify(command)}`,
    `    args: [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
    // cn spawns its MCP servers with its own environment, repo `.env` included: name every
    // variable align reads (JSON-quoted values are valid YAML scalars).
    '    env:',
    ...Object.entries(mcpChildEnv(c.env ?? {})).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`),
    '',
  ].join('\n');
  return { ...spec, args: ['--mcp', `file://${c.cachePath(FILE)}`, ...c.passthrough], files: [{ name: FILE, content }] };
}
