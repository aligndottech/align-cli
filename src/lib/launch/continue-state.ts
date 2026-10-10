import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { optionValue, readText } from './layer-files.js';
import type { AlignLocalState } from './strict-entry.js';
import { isCanonicalLocalEntry } from './strict-entry.js';
import { type Field, fields, listValue, meaningfulLines, scalarValue, topLevelBlock, type YamlLine } from './yaml-scan.js';

export interface ContinueProjectState extends Pick<AlignLocalState, 'present' | 'conflict'> {
  /** The local config file cn loads this session; null when it is a hub slug Align cannot read. */
  configFile: string | null;
}

/** The keys an `mcpServers` item may carry and still be exactly Align's own. */
const ALLOWED = new Set(['name', 'command', 'args', 'type']);

/**
 * Whether Continue's config.yaml already defines an `align-local` MCP server (cn 1.5.47, seen
 * against a stub model: a same-named server in config.yaml WINS over one injected with `--mcp`).
 *  - absent: none;
 *  - present: exactly `align mcp --env local` (a bare `align mcp` where that reads the local graph);
 *  - conflict: anything else, including any mention this reader cannot place.
 */
export function continueAlignLocal(text: string | null, o: { localIsDefault: boolean; platform: string }): 'absent' | 'present' | 'conflict' {
  if (text === null) return 'absent';
  const lines = meaningfulLines(text);
  if (lines === null) return 'conflict';
  const mentions = (ls: YamlLine[]) => ls.some((l) => l.text.includes('align-local'));
  const block = topLevelBlock(lines, 'mcpServers');
  if (block === 'inline' || block === null) return mentions(lines) ? 'conflict' : 'absent';
  if (block.length === 0) return 'absent';
  // Each item starts `- key: value`; rewrite that line as a mapping line two columns in.
  const items: YamlLine[][] = [];
  const itemIndent = block[0]!.indent;
  for (const l of block) {
    if (l.indent === itemIndent) {
      if (!l.text.startsWith('- ')) return 'conflict';
      items.push([{ indent: itemIndent + 2, text: l.text.slice(2).trim() }]);
    } else if (items.length > 0) {
      items[items.length - 1]!.push(l);
    } else {
      return 'conflict';
    }
  }
  let local: 'absent' | 'present' | 'conflict' = 'absent';
  let alignIsOurs = false;
  for (const item of items) {
    const f = fields(item);
    const name = f ? scalarValue(f.get('name')) : null;
    if (name === 'align') {
      if (f && !mentions(item) && canonicalItem(f, o)) alignIsOurs = true;
      else if (mentions(item)) return 'conflict';
      continue;
    }
    if (!mentions(item)) continue;
    if (!f || name !== 'align-local' || !canonicalItem(f, o)) return 'conflict';
    local = 'present';
  }
  return local === 'present' || alignIsOurs ? 'present' : 'absent';
}

/** An `mcpServers` item that is exactly Align's own local server, and carries nothing else. */
function canonicalItem(f: Map<string, Field>, o: { localIsDefault: boolean; platform: string }): boolean {
  for (const key of f.keys()) if (!ALLOWED.has(key)) return false;
  if (f.has('type') && scalarValue(f.get('type')) !== 'stdio') return false;
  const args = f.has('args') ? listValue(f.get('args')!) : [];
  return isCanonicalLocalEntry({ command: scalarValue(f.get('command')), args }, { localIsDefault: o.localIsDefault, platform: o.platform, host: 'mcpServers' });
}

/**
 * A `cn` on PATH is Continue CLI's only when it is the npm package's: both of Continue's
 * installers run `npm install -g @continuedev/cli`. POSIX: the bin link resolves into the package.
 * Windows: npm's `cn.cmd` shim sits beside `node_modules\@continuedev\cli`.
 */
export function isContinueBin(found: string, platform: string): boolean {
  if (platform === 'win32') return existsSync(path.join(path.dirname(found), 'node_modules', '@continuedev', 'cli'));
  try {
    return realpathSync(found).split(path.sep).join('/').includes('/@continuedev/cli/');
  } catch {
    return false;
  }
}

/** cn's continue home: the user's CONTINUE_GLOBAL_DIR (relative to the cwd), else ~/.continue. */
export function continueHome(home: string, env: Record<string, string | undefined>, cwd: string): string {
  return env['CONTINUE_GLOBAL_DIR'] ? path.resolve(cwd, env['CONTINUE_GLOBAL_DIR']) : path.join(home, '.continue');
}

/**
 * The file a `--config` value names, by cn's own rule (cn 1.5.47 configLoader.ts isFilePath):
 * a value starting `.`, `/` or `~`, a Windows drive or UNC path, or one containing `.yaml`,
 * `.yml` or `.json` is a file; anything else is a hub slug, even if a file of that name exists.
 * null for a slug, which align cannot read.
 */
function configPath(v: string, cwd: string, home: string): string | null {
  const isFile = v.startsWith('.') || v.startsWith('/') || v.startsWith('~') || /^[A-Za-z]:[/\\]/.test(v) || v.startsWith('\\\\') || v.includes('.yaml') || v.includes('.yml') || v.includes('.json');
  if (!isFile) return null;
  if (v.startsWith('file://')) return v.slice(7);
  if (v.startsWith('~')) return path.join(home, v.slice(1));
  return path.resolve(cwd, v);
}

/**
 * The config cn 1.5.47 loads this session, read for an align-local: the user's `--config` file
 * (a hub slug cannot be read here, and blocks nothing), else `<continue home>/config.yaml`, where
 * the continue home is CONTINUE_GLOBAL_DIR, else ~/.continue. cn runs dotenv in the cwd, so a
 * repo's `.env` could move it: the launch pins CONTINUE_GLOBAL_DIR to this one instead (registry
 * `pins`), and a process variable wins over dotenv. cn loads no workspace MCP files.
 */
export function readContinueState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
  passthrough: string[],
): ContinueProjectState {
  const flag = optionValue(passthrough, '--config');
  let configFile: string | null;
  if (flag !== undefined) {
    configFile = configPath(flag, cwd, home);
  } else {
    configFile = path.join(continueHome(home, env, cwd), 'config.yaml');
  }
  if (configFile === null) return { present: false, configFile: null };
  const verdict = continueAlignLocal(readText(configFile), { ...opts, platform });
  return verdict === 'conflict' ? { present: false, conflict: configFile, configFile } : { present: verdict === 'present', configFile };
}
