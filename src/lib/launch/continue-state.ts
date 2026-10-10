import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { optionValue, readText } from './layer-files.js';
import type { AlignLocalState } from './strict-entry.js';
import { isCanonicalLocalEntry } from './strict-entry.js';
import { fields, listValue, meaningfulLines, scalarValue, topLevelBlock, type YamlLine } from './yaml-scan.js';

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
  if (lines === null) return text.includes('align-local') ? 'conflict' : 'absent';
  const mentions = (ls: YamlLine[]) => ls.some((l) => l.text.includes('align-local'));
  if (!mentions(lines)) return 'absent';
  const block = topLevelBlock(lines, 'mcpServers');
  if (block === 'inline') return 'conflict';
  if (block === null || !mentions(block)) return 'absent';
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
  let verdict: 'absent' | 'present' | 'conflict' = 'absent';
  for (const item of items) {
    if (!mentions(item)) continue;
    const f = fields(item);
    if (!f || scalarValue(f.get('name')) !== 'align-local') return 'conflict';
    for (const key of f.keys()) if (!ALLOWED.has(key)) return 'conflict';
    if (f.has('type') && scalarValue(f.get('type')) !== 'stdio') return 'conflict';
    const args = f.has('args') ? listValue(f.get('args')!) : [];
    const entry = { command: scalarValue(f.get('command')), args };
    if (!isCanonicalLocalEntry(entry, { localIsDefault: o.localIsDefault, platform: o.platform, host: 'mcpServers' })) return 'conflict';
    verdict = 'present';
  }
  return verdict;
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

/** CONTINUE_GLOBAL_DIR from a dotenv file, as dotenv reads it: `[export ]KEY=value`, quotes stripped. */
function dotenvGlobalDir(file: string): string | undefined {
  const text = readText(file);
  if (text === null) return undefined;
  let value: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?CONTINUE_GLOBAL_DIR\s*=\s*(.*?)\s*$/.exec(line);
    if (m) value = m[1]!.replace(/^(['"`])(.*)\1$/, '$2');
  }
  return value;
}

/** A `--config` value cn treats as a file (decodePackageIdentifier: `.`, `/`, `~`, `file://`; or a path that exists). */
function configPath(v: string, cwd: string, home: string): string | null {
  if (v.startsWith('file://')) return v.slice(7);
  if (v.startsWith('~')) return path.join(home, v.slice(1));
  if (v.startsWith('.') || path.isAbsolute(v) || existsSync(path.resolve(cwd, v))) return path.resolve(cwd, v);
  return null;
}

/**
 * The config cn 1.5.47 loads this session, read for an align-local: the user's `--config` file
 * (a hub slug cannot be read here, and blocks nothing), else `<continue home>/config.yaml`, where
 * the continue home is CONTINUE_GLOBAL_DIR, else ~/.continue. cn runs dotenv in the cwd first, so
 * a repo's `.env` can set CONTINUE_GLOBAL_DIR when the user has not: that is followed too.
 * cn loads no workspace MCP files.
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
    const dir = env['CONTINUE_GLOBAL_DIR'] || dotenvGlobalDir(path.join(cwd, '.env'));
    configFile = path.join(dir ? path.resolve(cwd, dir) : path.join(home, '.continue'), 'config.yaml');
  }
  if (configFile === null) return { present: false, configFile: null };
  const verdict = continueAlignLocal(readText(configFile), { ...opts, platform });
  return verdict === 'conflict' ? { present: false, conflict: configFile, configFile } : { present: verdict === 'present', configFile };
}
