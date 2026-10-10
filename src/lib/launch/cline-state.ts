import path from 'node:path';
import { optionValue, readText } from './layer-files.js';
import { type AlignLocalState, type CanonicalOptions, isCanonicalLocalEntry, parseJsonc, unreadableMentionsAlign } from './strict-entry.js';

export interface ClineProjectState extends AlignLocalState {
  /** The one MCP settings file Cline CLI loads: the file align adds to. */
  mcpFile: string;
  /** The user's --config or --data-dir chose that file for this session only: align writes nothing there. */
  oneSession: boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const FILE = 'cline_mcp_settings.json';

/**
 * Where Cline CLI reads its MCP servers (cline 3.0.70, its bundled path code): CLINE_MCP_SETTINGS_PATH;
 * else `<data dir>/settings/cline_mcp_settings.json`, the data dir being CLINE_DATA_DIR, else
 * `<cline dir>/data`, the cline dir being the `--config` dir, else CLINE_DIR, else ~/.cline. A
 * `--data-dir` or `--config` in the user's own args is read for that session, so it is honoured.
 */
export function clineMcpFile(home: string, env: Record<string, string | undefined>, passthrough: string[]): string {
  if (env['CLINE_MCP_SETTINGS_PATH']?.trim()) return path.resolve(env['CLINE_MCP_SETTINGS_PATH'].trim());
  const dataFlag = optionValue(passthrough, '--data-dir');
  const configFlag = optionValue(passthrough, '--config');
  const clineDir = configFlag ? path.resolve(configFlag) : env['CLINE_DIR']?.trim() ? path.resolve(env['CLINE_DIR'].trim()) : path.join(home, '.cline');
  const dataDir = dataFlag ? path.resolve(dataFlag) : env['CLINE_DATA_DIR']?.trim() ? path.resolve(env['CLINE_DATA_DIR'].trim()) : path.join(clineDir, 'data');
  return path.join(dataDir, 'settings', FILE);
}

/** `cline mcp add` wraps the command in `transport` (3.0.70); the flat form loads too. */
function canonical(entry: unknown, o: CanonicalOptions): boolean {
  if (isObject(entry) && Object.keys(entry).length === 1 && isObject(entry['transport'])) {
    const { type, ...rest } = entry['transport'];
    return type === 'stdio' && isCanonicalLocalEntry(rest, o);
  }
  return isCanonicalLocalEntry(entry, o);
}

/**
 * What Cline CLI would already load for align (cline 3.0.70): one MCP settings file, no repo
 * layer (checked in a sandbox: a repo's `.cline/` MCP files were not listed by `cline config
 * --json`). A canonical align-local or `align` there is present; any other align-local is a
 * conflict, because the writer adds and never edits.
 */
export function readClineState(
  _cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
  passthrough: string[],
): ClineProjectState {
  const o = { ...opts, platform, host: 'mcpServers' as const };
  const mcpFile = clineMcpFile(home, env, passthrough);
  const oneSession = optionValue(passthrough, '--config') !== undefined || optionValue(passthrough, '--data-dir') !== undefined;
  const state: ClineProjectState = { present: false, overridden: [], mcpFile, oneSession };
  const text = readText(mcpFile);
  const parsed = parseJsonc(text);
  // Fail closed: a file align cannot parse but that names align may hold a server it cannot see.
  if (unreadableMentionsAlign(text, parsed)) return { ...state, conflict: mcpFile };
  const servers = parsed?.['mcpServers'];
  if (!isObject(servers)) return state;
  if (canonical(servers['align'], o) || canonical(servers['align-local'], o)) state.present = true;
  else if ('align-local' in servers) state.conflict = mcpFile;
  return state;
}
