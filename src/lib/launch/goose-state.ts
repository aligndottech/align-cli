import path from 'node:path';
import { readText } from './layer-files.js';
import type { AlignLocalState } from './strict-entry.js';
import { isCanonicalLocalEntry } from './strict-entry.js';
import { type Field, fields, listValue, meaningfulLines, scalarValue, topLevelBlock, type YamlLine } from './yaml-scan.js';

export interface GooseProjectState extends Pick<AlignLocalState, 'present' | 'conflict'> {
  /** The config.yaml Goose reads: where a clashing extension would sit. Read only, never written. */
  configFile: string;
}

const pathFor = (platform: string) => (platform === 'win32' ? path.win32 : path.posix);

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
  name: (f) => scalarValue(f) === 'align-local',
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
  if (lines === null) return text.includes('align-local') ? 'conflict' : 'absent';
  const mentions = (ls: YamlLine[]) => ls.some((l) => l.text.includes('align-local'));
  if (!mentions(lines)) return 'absent';
  const block = topLevelBlock(lines, 'extensions');
  if (block === 'inline') return 'conflict';
  if (block === null || !mentions(block)) return 'absent';
  const exts = fields(block);
  if (!exts) return 'conflict';
  let found: Field | undefined;
  for (const [key, f] of exts) {
    if (key === 'align-local') found = f;
    else if (mentions(f.children) || f.inline.includes('align-local')) return 'conflict';
  }
  if (!found || found.inline !== '') return 'conflict';
  const body = fields(found.children);
  if (!body) return 'conflict';
  const enabled = scalarValue(body.get('enabled'));
  if (enabled === 'false') return 'absent';
  if (enabled !== 'true') return 'conflict';
  for (const [key, f] of body) if (!Object.hasOwn(ALLOWED, key) || !ALLOWED[key]!(f)) return 'conflict';
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
