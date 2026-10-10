import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { optionValue, readText } from './layer-files.js';
import type { AlignLocalState } from './strict-entry.js';
import { isCanonicalLocalEntry } from './strict-entry.js';
import { type Field, fields, listValue, meaningfulLines, scalarValue, topLevelBlock, type YamlLine } from './yaml-scan.js';

export interface GooseProjectState extends Pick<AlignLocalState, 'present' | 'conflict'> {
  /** The config.yaml Goose reads: where a clashing extension would sit. Read only, never written. */
  configFile: string;
}

const pathFor = (platform: string) => (platform === 'win32' ? path.win32 : path.posix);

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Whether a `goose` on PATH is Block's agent. `goose` is also pressly/goose, a common Go
 * database-migration CLI, and Homebrew ships both under bin/goose (formula `goose` is pressly's,
 * `block-goose-cli` is Block's). So it counts only from Block's documented install places, judged
 * on the real path (a link in an allowed dir to pressly's binary does not pass):
 *  - the installer's $GOOSE_BIN_DIR (download_cli.sh: default ~/.local/bin, %USERPROFILE%\goose
 *    on Windows);
 *  - Homebrew's Cellar/block-goose-cli.
 * Nothing is executed. A Block goose installed any other way is not detected (fail closed).
 */
export function isGooseBin(found: string, env: Record<string, string | undefined>, platform: string): boolean {
  const p = pathFor(platform);
  const resolved = platform === 'win32' ? found : real(found);
  if (resolved.split(p.sep).join('/').includes('/Cellar/block-goose-cli/')) return true;
  const home = (platform === 'win32' ? env['USERPROFILE'] || env['HOME'] : env['HOME']) || os.homedir();
  const dir = env['GOOSE_BIN_DIR'] ? p.resolve(env['GOOSE_BIN_DIR']) : platform === 'win32' ? p.join(home, 'goose') : p.join(home, '.local', 'bin');
  const allowed = platform === 'win32' ? dir.toLowerCase() : real(dir);
  const actual = platform === 'win32' ? p.dirname(resolved).toLowerCase() : p.dirname(resolved);
  return actual === allowed;
}

/**
 * Goose's config.yaml (goose 1.54.0, `goose info` in a sandbox): GOOSE_PATH_ROOT/config, else the
 * XDG config dir (Linux and macOS alike: `$XDG_CONFIG_HOME/goose`, default ~/.config/goose). On
 * Windows %APPDATA%\Block\goose\config (goose docs, config files guide; not run on Windows).
 */
export function gooseConfigFile(home: string, env: Record<string, string | undefined>, platform: string): string {
  const p = pathFor(platform);
  if (env['GOOSE_PATH_ROOT']) return p.join(p.resolve(env['GOOSE_PATH_ROOT']), 'config', 'config.yaml');
  if (platform === 'win32') return p.join(env['APPDATA'] || p.join(home, 'AppData', 'Roaming'), 'Block', 'goose', 'config', 'config.yaml');
  return p.join(env['XDG_CONFIG_HOME'] || p.join(home, '.config'), 'goose', 'config.yaml');
}

/** The keys a goose stdio extension may carry and still be exactly Align's own, and what they must hold. */
const ALLOWED: Record<string, (f: Field) => boolean> = {
  enabled: (f) => scalarValue(f) === 'true',
  type: (f) => scalarValue(f) === 'stdio',
  cmd: (f) => scalarValue(f) !== null,
  args: (f) => listValue(f) !== null,
  timeout: (f) => /^\d+$/.test(scalarValue(f) ?? ''),
  description: (f) => f.children.length === 0,
  bundled: (f) => ['null', '~', 'false'].includes(scalarValue(f) ?? '') || (f.inline === '' && f.children.length === 0),
  envs: (f) => f.inline === '{}' && f.children.length === 0,
  env_keys: (f) => f.inline === '[]' && f.children.length === 0,
  available_tools: (f) => f.inline === '[]' && f.children.length === 0,
};

/**
 * Whether Goose's config.yaml already holds an `align-local` extension (goose 1.54.0, seen in a
 * sandbox): an ENABLED one with the same name makes goose refuse to start when Align adds its own
 * ("extension name 'align-local' is already in use"); a disabled one does not clash.
 *  - absent: no align-local, or a disabled one;
 *  - present: enabled and exactly `align mcp --env local` (a bare `align mcp` where that reads the
 *    local graph), with no key that could change what runs;
 *  - conflict: anything else, including any mention this reader cannot place.
 */
export function gooseAlignLocal(text: string | null, o: { localIsDefault: boolean; platform: string }): 'absent' | 'present' | 'conflict' {
  if (text === null) return 'absent';
  const lines = meaningfulLines(text);
  if (lines === null) return 'conflict';
  const mentions = (ls: YamlLine[]) => ls.some((l) => l.text.includes('align-local'));
  const block = topLevelBlock(lines, 'extensions');
  if (block === 'inline') return mentions(lines) ? 'conflict' : 'absent';
  if (block === null) return mentions(lines) ? 'conflict' : 'absent';
  const exts = fields(block);
  if (!exts) return mentions(block) ? 'conflict' : 'absent';
  // A mention of align-local anywhere but its own key cannot be placed: a `name:` field may rename.
  for (const [key, f] of exts) if (key !== 'align-local' && (mentions(f.children) || f.inline.includes('align-local'))) return 'conflict';
  const local = exts.has('align-local') ? extension(exts.get('align-local')!, 'align-local', o) : 'absent';
  if (local === 'conflict') return 'conflict';
  // An enabled, exactly-ours extension under either name already serves the graph.
  const align = exts.has('align') ? extension(exts.get('align')!, 'align', o) : 'absent';
  return local === 'present' || align === 'present' ? 'present' : 'absent';
}

/** One extension's verdict: disabled is absent, exactly Align's own is present, anything else a conflict. */
function extension(f: Field, name: string, o: { localIsDefault: boolean; platform: string }): 'absent' | 'present' | 'conflict' {
  if (f.inline !== '') return 'conflict';
  const body = fields(f.children);
  if (!body) return 'conflict';
  const enabled = scalarValue(body.get('enabled'));
  if (enabled === 'false') return 'absent';
  if (enabled !== 'true') return 'conflict';
  for (const [key, v] of body) {
    if (key === 'name' ? scalarValue(v) !== name : !Object.hasOwn(ALLOWED, key) || !ALLOWED[key]!(v)) return 'conflict';
  }
  const cmd = scalarValue(body.get('cmd'));
  const args = body.has('args') ? listValue(body.get('args')!) : [];
  const ours = isCanonicalLocalEntry({ command: cmd, args }, { localIsDefault: o.localIsDefault, platform: o.platform, host: 'mcpServers' });
  return ours ? 'present' : 'conflict';
}

/** What Goose would already load for align: its one config.yaml (it has no project-level extension config). */
export function readGooseState(_cwd: string, home: string, opts: { localIsDefault: boolean }, env: Record<string, string | undefined>, platform: string): GooseProjectState {
  const configFile = gooseConfigFile(home, env, platform);
  const verdict = gooseAlignLocal(readText(configFile), { ...opts, platform });
  return verdict === 'conflict' ? { present: false, conflict: configFile, configFile } : { present: verdict === 'present', configFile };
}

/**
 * A recipe the user runs (`--recipe <file>`) that names align-local: goose would refuse to start
 * if Align added its own under that name. Returns that file. Only a recipe given as a readable
 * path is checked; a recipe named by its title is resolved by goose and not read here.
 */
export function gooseRecipeMentions(cwd: string, passthrough: string[]): string | undefined {
  const r = optionValue(passthrough, '--recipe');
  if (!r) return undefined;
  const file = path.resolve(cwd, r);
  return readText(file)?.includes('align-local') ? file : undefined;
}
