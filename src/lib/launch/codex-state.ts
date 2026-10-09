import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { type AlignLocalState, foldLayers, type Layer } from './strict-entry.js';

export type CodexProjectState = AlignLocalState;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A config.toml as an object. Missing or unparseable reads as empty: Codex itself refuses to
 * start on a config.toml it cannot parse and names the error, so no entry in it can run
 * either, and injecting as if it were absent changes nothing about what the user sees.
 */
function readToml(file: string): Json {
  try {
    const parsed: unknown = parse(readFileSync(file, 'utf8'));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The git root above cwd (cwd included), or null with no .git anywhere above. */
function gitRoot(cwd: string): string | null {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Project dirs Codex reads .codex/config.toml from, outermost first: git root down to cwd, or cwd alone. */
function projectDirs(cwd: string, root: string | null): string[] {
  if (root === null) return [cwd];
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (dir === root || path.dirname(dir) === dir) return dirs;
  }
}

/** Codex loads project config only for a trusted project: `[projects."<git root or cwd>"] trust_level = "trusted"`. */
function trusted(user: Json, cwd: string, root: string | null): boolean {
  const projects = isObject(user['projects']) ? user['projects'] : {};
  return [root ?? cwd, cwd].some((k) => (projects[k] as Json | undefined)?.['trust_level'] === 'trusted');
}

/** Every key -c overrides when it replaces align-local: command, args, and enabled=true. */
const REPLACEABLE = new Set(['command', 'args', 'enabled']);

/**
 * What Codex would already load for align, read with a TOML parser (sub-tables, dotted keys and
 * inline tables all land on the same object). Layers in Codex's merge order: $CODEX_HOME (or
 * ~/.codex)/config.toml, then each .codex/config.toml from the git root down to cwd, and those
 * only when Codex trusts the project (verified on 0.153.0: an untrusted repo's file is ignored).
 */
export function readCodexState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
): CodexProjectState {
  const userFile = path.join(env['CODEX_HOME'] ? env['CODEX_HOME'] : path.join(home, '.codex'), 'config.toml');
  const user = readToml(userFile);
  const root = gitRoot(cwd);
  const layers: Layer[] = [{ file: userFile, servers: user['mcp_servers'] }];
  if (trusted(user, cwd, root)) {
    for (const dir of projectDirs(cwd, root)) {
      const file = path.join(dir, '.codex', 'config.toml');
      layers.push({ file, servers: readToml(file)['mcp_servers'] });
    }
  }
  return foldLayers(layers, { ...opts, platform, host: 'codex' }, (e) => isObject(e) && Object.keys(e).every((k) => REPLACEABLE.has(k)));
}
