import { readFileSync } from 'node:fs';
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

/** cwd and every directory above it, to the filesystem root. */
function ancestors(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.dirname(dir) === dir) return dirs;
  }
}

/**
 * The profile a user's own args select (`-p name`, `--profile name`, `--profile=name`, before
 * any `--`). Codex layers $CODEX_HOME/<name>.config.toml for it. A name that could leave that
 * directory (a separator, `..`) is never made into a path: undefined.
 */
export function codexProfile(passthrough: string[]): string | undefined {
  let name: string | undefined;
  for (let i = 0; i < passthrough.length; i++) {
    const a = passthrough[i]!;
    if (a === '--') break;
    if (a === '-p' || a === '--profile') name = passthrough[++i];
    else if (a.startsWith('--profile=')) name = a.slice('--profile='.length);
  }
  if (!name || /[/\\]/.test(name) || name.includes('..')) return undefined;
  return name;
}

/** Every key -c overrides when it replaces align-local: command, args, and enabled=true. */
const REPLACEABLE = new Set(['command', 'args', 'enabled']);

/**
 * What Codex would already load for align, read with a TOML parser (sub-tables, dotted keys and
 * inline tables all land on the same object).
 *
 * The CONFLICT scan reads every layer Codex might load, whatever the trust state, and fails
 * closed. align cannot reproduce Codex's project resolution: a worktree resolves to its main
 * repo's trust, an untrusted repo becomes trusted with one Enter at Codex's prompt and reloads
 * WITH our -c overrides, and `project_root_markers` can put the project root ABOVE the git
 * root (all verified on 0.153.0). So: /etc/codex/config.toml and managed_config.toml (both
 * named in the 0.153.0 binary), $CODEX_HOME (or ~/.codex)/config.toml, the profile file a
 * `-p`/`--profile` in the user's args selects, and EVERY .codex/config.toml from cwd up to the
 * filesystem root (a superset, so it can only over-refuse). The user config met again as an
 * ancestor is read once, as the user layer.
 *
 * "Already present" counts only the user, profile and system layers. A project's canonical
 * align-local is simply overwritten by our identical -c values; a project's canonical `align`
 * at worst duplicates tools.
 */
export function readCodexState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean; systemDir?: string },
  env: Record<string, string | undefined>,
  platform: string,
  passthrough: string[] = [],
): CodexProjectState {
  const o = { localIsDefault: opts.localIsDefault, platform, host: 'codex' as const };
  const replaceable = (e: unknown): boolean => isObject(e) && Object.keys(e).every((k) => REPLACEABLE.has(k));
  const at = (file: string): Layer => ({ file, servers: readToml(file)['mcp_servers'] });
  const systemDir = opts.systemDir ?? '/etc/codex';
  const codexHome = env['CODEX_HOME'] ? env['CODEX_HOME'] : path.join(home, '.codex');
  const userFile = path.resolve(codexHome, 'config.toml');
  const profile = codexProfile(passthrough);
  const base = foldLayers(
    [
      at(path.join(systemDir, 'config.toml')),
      at(userFile),
      ...(profile ? [at(path.join(codexHome, `${profile}.config.toml`))] : []),
      at(path.join(systemDir, 'managed_config.toml')),
    ],
    o,
    replaceable,
  );
  const projectFiles = ancestors(cwd).map((d) => path.join(d, '.codex', 'config.toml')).filter((f) => f !== userFile);
  const project = foldLayers(projectFiles.map(at), o, replaceable);
  const conflict = base.conflict ?? project.conflict;
  return {
    present: base.present,
    overridden: [...base.overridden, ...project.overridden],
    ...(conflict ? { conflict } : {}),
  };
}
