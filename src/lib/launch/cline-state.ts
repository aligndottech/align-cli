import path from 'node:path';
import { optionValue, readText } from './layer-files.js';
import { classifyChildEnv } from './mcp-child-env.js';
import { type AlignLocalState, type CanonicalOptions, isCanonicalLocalEntry, parseJsonc, unreadableMentionsAlign } from './strict-entry.js';

export interface ClineProjectState extends AlignLocalState {
  /** The one MCP settings file Cline CLI loads: the file align adds to. */
  mcpFile: string;
  /** The user's --config or --data-dir chose that file for this session only: align writes nothing there. */
  oneSession: boolean;
  /** Align's own entry, with an older key set or values that have changed since: refresh it. */
  stale?: boolean;
  /** The conflict is an env value Align did not write: which key. */
  envConflictKey?: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const FILE = 'cline_mcp_settings.json';

/**
 * Where a Cline session reads its MCP servers (cline 3.0.70, its bundled path code):
 * CLINE_MCP_SETTINGS_PATH; else `<data dir>/settings/cline_mcp_settings.json`. The data dir is the
 * user's `--data-dir` (its sandbox setup sets CLINE_DATA_DIR from it; checked in a real session:
 * `cline --data-dir X "..."` loaded X/settings' server), else CLINE_DATA_DIR, else
 * `<cline dir>/data`, the cline dir being the user's `--config` dir, else CLINE_DIR, else ~/.cline.
 * (`cline config --json` ignores --data-dir, which is why an earlier check misread it.)
 */
function clineDirs(home: string, env: Record<string, string | undefined>, passthrough: string[]): { clineDir: string; dataDir: string; mcpFile: string } {
  const configFlag = optionValue(passthrough, '--config');
  const dataFlag = optionValue(passthrough, '--data-dir');
  const userDir = env['CLINE_DIR']?.trim() ? path.resolve(env['CLINE_DIR'].trim()) : path.join(home, '.cline');
  const clineDir = configFlag ? path.resolve(configFlag) : userDir;
  const dataDir = dataFlag ? path.resolve(dataFlag) : env['CLINE_DATA_DIR']?.trim() ? path.resolve(env['CLINE_DATA_DIR'].trim()) : path.join(clineDir, 'data');
  const mcp = env['CLINE_MCP_SETTINGS_PATH']?.trim();
  return { clineDir: userDir, dataDir, mcpFile: mcp ? path.resolve(mcp) : path.join(dataDir, 'settings', FILE) };
}

export function clineMcpFile(home: string, env: Record<string, string | undefined>, passthrough: string[]): string {
  return clineDirs(home, env, passthrough).mcpFile;
}

/**
 * The variables that place Cline's files, as cline would resolve them this launch. Cline loads
 * `.env`/`.env.local` from the cwd, so the launch pins them (only those the user did not export);
 * a process variable wins over its dotenv. CLINE_DIR is pinned to the user's own dir even with
 * `--config`, which beats it anyway; CLINE_DATA_DIR follows `--config` and `--data-dir`, because an
 * exported one beats `--config` (checked) and must not undo the user's flag. Without `--data-dir`,
 * the sandbox switches are pinned off: a repo `.env` with CLINE_SANDBOX=1 would move the data dir
 * and the provider settings. Empty is a no-op for all three in cline's source (`?.trim()` checks).
 */
export function clinePins(home: string, env: Record<string, string | undefined>, passthrough: string[]): Record<string, string> {
  const d = clineDirs(home, env, passthrough);
  // Cline reads each one with `?.trim()` and skips it when empty (cline 3.0.70 bundled binary:
  // the sandbox switch in Ed(), P(), lh(), Xd(), xi(), oa()), so empty is a no-op. With
  // --data-dir, cline's own sandbox setup sets these from the flag.
  const sandboxOff: Record<string, string> = optionValue(passthrough, '--data-dir') === undefined
    ? { CLINE_SANDBOX: '', CLINE_SANDBOX_DATA_DIR: '', CLINE_PROVIDER_SETTINGS_PATH: '', CLINE_GLOBAL_SETTINGS_PATH: '', CLINE_SESSION_DATA_DIR: '', CLINE_DB_DATA_DIR: '' }
    : {};
  return { CLINE_DIR: d.clineDir, CLINE_DATA_DIR: d.dataDir, CLINE_MCP_SETTINGS_PATH: d.mcpFile, ...sandboxOff };
}

/** `cline mcp add` wraps the command in `transport` (3.0.70); the flat form loads too. */
function unwrap(entry: unknown): unknown {
  if (isObject(entry) && Object.keys(entry).length === 1 && isObject(entry['transport'])) {
    const { type, ...rest } = entry['transport'];
    return type === 'stdio' ? rest : undefined;
  }
  return entry;
}

/**
 * Align's own entry, judged with today's environment: `present` (no env block, or a current
 * one), `stale` (Align's block from an older key set, or values that have changed: refresh it),
 * `envConflict` (an env value Align never writes) or `foreign` (anything else).
 */
function judge(entry: unknown, o: CanonicalOptions, env: Record<string, string | undefined>): { kind: 'present' | 'stale' | 'foreign' } | { kind: 'envConflict'; key: string } {
  const e = unwrap(entry);
  if (!isObject(e)) return { kind: 'foreign' };
  if (!('env' in e)) return isCanonicalLocalEntry(e, o) ? { kind: 'present' } : { kind: 'foreign' };
  const { env: block, ...rest } = e;
  if (!isCanonicalLocalEntry(rest, o)) return { kind: 'foreign' };
  const c = classifyChildEnv(block, env);
  if (c.kind === 'foreign') return { kind: 'envConflict', key: c.key };
  return { kind: c.kind === 'current' ? 'present' : 'stale' };
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
  if (judge(servers['align'], o, env).kind === 'present') state.present = true;
  if (!('align-local' in servers)) return state;
  const v = judge(servers['align-local'], o, env);
  if (v.kind === 'present') state.present = true;
  else if (v.kind === 'stale') state.stale = true;
  else {
    state.conflict = mcpFile;
    if (v.kind === 'envConflict') state.envConflictKey = v.key;
  }
  return state;
}
