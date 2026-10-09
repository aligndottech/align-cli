import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { ancestors, optionValue, readText } from './layer-files.js';
import { type AlignLocalState, isCanonicalLocalEntry, parseJsonc } from './strict-entry.js';

export interface GrokProjectState extends AlignLocalState {
  /** $GROK_HOME/config.toml (else ~/.grok/config.toml): the file align adds to. */
  configFile: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const pathFor = (platform: string) => (platform === 'win32' ? path.win32 : path.posix);

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The user's home as Grok Build resolves it: $HOME (USERPROFILE on Windows), else the OS's. */
function homeOf(env: Record<string, string | undefined>, platform: string): string {
  const h = platform === 'win32' ? env['USERPROFILE'] || env['HOME'] : env['HOME'];
  return h ? h : os.homedir();
}

/**
 * $GROK_HOME verbatim when non-empty, else `<home>/.grok` with the home's symlinks resolved, as
 * Grok Build's own installer and `grok_home()` do (xai-org/grok-build xai-dirs, npm postinstall.js).
 */
export function grokHome(env: Record<string, string | undefined>, platform: string, home = homeOf(env, platform)): string {
  if (env['GROK_HOME']) return pathFor(platform).resolve(env['GROK_HOME']);
  return pathFor(platform).join(platform === 'win32' ? home : real(home), '.grok');
}

const inside = (child: string, parent: string, platform: string): boolean => {
  const p = pathFor(platform);
  const norm = (x: string) => (platform === 'win32' ? p.resolve(x).toLowerCase() : p.resolve(x));
  const rel = p.relative(norm(parent), norm(child));
  return rel !== '' && !rel.startsWith(`..${p.sep}`) && rel !== '..' && !p.isAbsolute(rel);
};

export interface BinFs {
  realpath(p: string): string;
  exists(p: string): boolean;
}
const realFs: BinFs = { realpath: (p) => realpathSync(p), exists: (p) => existsSync(p) };

/**
 * `grok` is a generic name, so a `grok` on PATH is Grok Build only when its realpath sits where
 * Grok Build's own installers put it:
 *  - the install script (x.ai/cli/install.sh): `$GROK_HOME/downloads/grok-<platform>`, linked from
 *    `$GROK_HOME/bin/grok` (and from `$GROK_BIN_DIR` or ~/.local/bin, which resolve to the same);
 *  - its Windows script: a copy at `%USERPROFILE%\.grok\bin\grok.exe`;
 *  - the npm package `@xai-official/grok`: its postinstall installs into `$GROK_HOME/bin`, and the
 *    npm entry itself lives in `node_modules/@xai-official/grok[-<platform>]/`. On Windows npm's
 *    `grok.cmd` shim sits beside `node_modules`, so it counts when that package is next to it.
 * Anything else (another tool's `grok`) is not Grok Build, and counts as not installed.
 */
export function isGrokBuildBin(found: string, env: Record<string, string | undefined>, platform: string, fsx: BinFs = realFs): boolean {
  let resolved: string;
  try {
    resolved = fsx.realpath(found);
  } catch {
    return false;
  }
  const g = grokHome(env, platform);
  const p = pathFor(platform);
  if (inside(resolved, p.join(g, 'bin'), platform) || inside(resolved, p.join(g, 'downloads'), platform)) return true;
  const parts = resolved.split(/[\\/]/);
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i] === 'node_modules' && parts[i + 1] === '@xai-official' && /^grok(-[a-z0-9]+-[a-z0-9]+)?$/.test(parts[i + 2]!)) return true;
  }
  if (platform === 'win32' && /^grok\.cmd$/i.test(p.basename(resolved))) {
    return fsx.exists(p.join(p.dirname(resolved), 'node_modules', '@xai-official', 'grok', 'package.json'));
  }
  return false;
}

function readToml(file: string): Json | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    const parsed: unknown = parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What Grok Build (grok 1.0.50) would already load for align, measured with `grok mcp list` and
 * `grok inspect` in a sandbox:
 *  - `$GROK_HOME/config.toml` `[mcp_servers.*]`: the user file align writes to;
 *  - a project `.grok/config.toml` (repo root down to the cwd; every ancestor is read here):
 *    "A project file entirely replaces a same-named server from the user config", so a
 *    non-canonical align-local there would replace ours: a conflict, nothing is written;
 *  - ~/.claude.json and ~/.cursor/mcp.json (Grok imports them): a same-named server there LOSES
 *    to config.toml (verified), so it is no conflict; a canonical local `align` there is present.
 * A project `.mcp.json` is repo input and never counts as present. The project is `--cwd` when
 * the user passes one.
 */
export function readGrokState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
  passthrough: string[] = [],
): GrokProjectState {
  // `grok --cwd <dir>` moves the project Grok loads; relative to the cwd, as a shell gives it.
  const project = path.resolve(cwd, optionValue(passthrough, '--cwd') ?? '.');
  const o = { ...opts, platform, host: 'mcpServers' as const };
  // A path on this machine's own filesystem: built with the host's path rules (in production the
  // platform is the host's anyway). grokHome uses `platform`'s rules for the binary gate.
  const configFile = path.join(env['GROK_HOME'] ? path.resolve(env['GROK_HOME']) : path.join(home, '.grok'), 'config.toml');
  const userServers = readToml(configFile)?.['mcp_servers'];
  const state: GrokProjectState = { present: false, overridden: [], configFile };
  const canonical = (s: unknown) => isObject(s) && (isCanonicalLocalEntry(s['align'], o) || isCanonicalLocalEntry(s['align-local'], o));
  if (canonical(userServers)) state.present = true;
  else if (isObject(userServers) && 'align-local' in userServers) state.conflict = configFile;
  for (const dir of ancestors(project)) {
    const file = path.join(dir, '.grok', 'config.toml');
    if (file === configFile) continue;
    const servers = readToml(file)?.['mcp_servers'];
    if (isObject(servers) && 'align-local' in servers && !isCanonicalLocalEntry(servers['align-local'], o)) state.conflict ??= file;
  }
  // `[compat.claude] mcps = false` / `[compat.cursor] mcps = false` turn those imports off.
  const compat = (readToml(configFile)?.['compat'] ?? {}) as Json;
  const imported = (tool: string) => !(isObject(compat[tool]) && (compat[tool] as Json)['mcps'] === false);
  const claude = parseJsonc(readText(path.join(home, '.claude.json')))?.['mcpServers'];
  const cursor = parseJsonc(readText(path.join(home, '.cursor', 'mcp.json')))?.['mcpServers'];
  if (imported('claude') && isObject(claude) && isCanonicalLocalEntry(claude['align'], o)) state.present = true;
  if (imported('cursor') && isObject(cursor) && isCanonicalLocalEntry(cursor['align'], o)) state.present = true;
  return state;
}
