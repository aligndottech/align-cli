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

/** The nearest ancestor (cwd included) holding `.git`, a directory or a worktree's file; null with none. */
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

/** Every key -c overrides when it replaces align-local: command, args, and enabled=true. */
const REPLACEABLE = new Set(['command', 'args', 'enabled']);

/**
 * What Codex would already load for align, read with a TOML parser (sub-tables, dotted keys and
 * inline tables all land on the same object).
 *
 * The CONFLICT scan reads every layer Codex might load, whatever the trust state, and fails
 * closed. align cannot reproduce Codex's trust resolution: a worktree resolves to its main
 * repo's trust, and an untrusted repo becomes trusted with one Enter at Codex's own prompt,
 * after which the config reloads WITH our -c overrides and the repo's keys merge into them
 * (both verified on 0.153.0). So: /etc/codex/config.toml, /etc/codex/managed_config.toml (both
 * named in the 0.153.0 binary), $CODEX_HOME (or ~/.codex)/config.toml, and each .codex/config.toml
 * from the nearest ancestor holding `.git` (a dir, or a worktree's file) down to cwd, or cwd alone.
 *
 * "Already present" counts only the user and system layers. A project's canonical align-local
 * is simply overwritten by our identical -c values; a project's canonical `align` at worst
 * duplicates tools.
 */
export function readCodexState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean; systemDir?: string },
  env: Record<string, string | undefined>,
  platform: string,
): CodexProjectState {
  const o = { localIsDefault: opts.localIsDefault, platform, host: 'codex' as const };
  const replaceable = (e: unknown): boolean => isObject(e) && Object.keys(e).every((k) => REPLACEABLE.has(k));
  const at = (file: string): Layer => ({ file, servers: readToml(file)['mcp_servers'] });
  const systemDir = opts.systemDir ?? '/etc/codex';
  const userFile = path.join(env['CODEX_HOME'] ? env['CODEX_HOME'] : path.join(home, '.codex'), 'config.toml');
  const base = foldLayers([at(path.join(systemDir, 'config.toml')), at(userFile), at(path.join(systemDir, 'managed_config.toml'))], o, replaceable);
  const project = foldLayers(projectDirs(cwd, gitRoot(cwd)).map((d) => at(path.join(d, '.codex', 'config.toml'))), o, replaceable);
  const conflict = base.conflict ?? project.conflict;
  return {
    present: base.present,
    overridden: [...base.overridden, ...project.overridden],
    ...(conflict ? { conflict } : {}),
  };
}
