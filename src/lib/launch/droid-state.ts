import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { ALIGN_NUDGE_START } from '../agent-rules.js';
import { ancestors, optionValue, readText } from './layer-files.js';
import { type AlignLocalState, foldLayers, isCanonicalLocalEntry, type Layer, parseJsonc } from './strict-entry.js';

export interface DroidProjectState extends AlignLocalState {
  /** The user runs Droid with their own runtime settings (`--settings` or FACTORY_RUNTIME_SETTINGS_PATH). */
  ownSettings?: string;
  /** A guideline file Droid reads already carries align's managed instructions block. */
  projectHasBlock: boolean;
}

/** Droid's guideline file names and the dirs it looks in beside each directory (droid 0.237.0). */
const GUIDELINES = ['CLAUDE.md', 'Claude.md', 'AGENTS.md', 'Agents.md', 'agents.md'];
const CONTEXT_DIRS = ['.factory', '.agents', '.agent'];

/** The nearest directory at or above `start` holding `.git` (a dir, or a worktree's file). */
function gitRoot(start: string): string | undefined {
  return ancestors(start).find((d) => existsSync(path.join(d, '.git')));
}

/** Droid's walk: `start` up to the git root, or `start` alone when there is none. */
function projectDirs(start: string): string[] {
  const root = gitRoot(start);
  if (!root) return [start];
  const all = ancestors(start);
  return all.slice(0, all.indexOf(root) + 1);
}

/** A regular file, not a link (Droid's lstat check ignores links), holding the block. */
function guidelineHasBlock(dir: string, name: string): boolean {
  const file = path.join(dir, name);
  try {
    if (!lstatSync(file).isFile()) return false;
  } catch {
    return false;
  }
  return readText(file)?.includes(ALIGN_NUDGE_START) ?? false;
}

function isRealDir(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What Factory Droid (droid 0.237.0) would already load for align. The project is `--cwd` when
 * the user passes one (relative to the cwd), else the cwd; "home" is FACTORY_HOME_OVERRIDE when
 * set (Droid's own home resolution).
 *  - MCP: $home/.factory/mcp.json, and a `.factory/mcp.json` from the project up to the git root
 *    (to the filesystem root with no git root). The per-process runtime settings win a same-named
 *    server (verified with `droid --settings f mcp list`), so a non-canonical align-local is
 *    overridden. Only the user's own canonical `align` stands in for us.
 *  - Instructions: Droid's own guideline discovery (agentsMdGuidelines): the project up to the
 *    git root, or only the project with none, each dir plus its .factory/.agents/.agent, plus
 *    $home/.factory, .agents and .agent; CLAUDE.md, AGENTS.md and case variants; a linked file or
 *    directory is ignored, as Droid's lstat checks ignore it.
 */
export function readDroidState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
  passthrough: string[],
): DroidProjectState {
  const userCwd = optionValue(passthrough, '--cwd');
  const start = path.resolve(cwd, userCwd ?? '.');
  const droidHome = env['FACTORY_HOME_OVERRIDE'] ? path.resolve(env['FACTORY_HOME_OVERRIDE']) : home;
  const userFile = path.join(droidHome, '.factory', 'mcp.json');
  const layer = (file: string): Layer => ({ file, servers: parseJsonc(readText(file))?.['mcpServers'] });
  const user = layer(userFile);
  const root = gitRoot(start);
  const mcpDirs = root ? projectDirs(start) : ancestors(start);
  const layers = [user, ...mcpDirs.map((d) => layer(path.join(d, '.factory', 'mcp.json'))).filter((l) => l.file !== userFile)];
  const o = { ...opts, platform, host: 'droid' as const };
  const { overridden } = foldLayers(layers, o, () => true);
  const present = isCanonicalLocalEntry((user.servers as Record<string, unknown> | undefined)?.['align'], o);
  const own = optionValue(passthrough, '--settings') ?? (env['FACTORY_RUNTIME_SETTINGS_PATH'] ? env['FACTORY_RUNTIME_SETTINGS_PATH'] : undefined);

  const personal = CONTEXT_DIRS.map((d) => path.join(droidHome, d));
  const dirs = projectDirs(start).filter((d) => d !== droidHome).flatMap((d) => [d, ...CONTEXT_DIRS.map((c) => path.join(d, c))]).filter((d) => !personal.includes(d));
  // Droid looks only in a real directory (not a link) at a regular file (not a link): lstat both.
  const projectHasBlock = [...dirs, ...personal].some((dir) => isRealDir(dir) && GUIDELINES.some((name) => guidelineHasBlock(dir, name)));
  return { present, overridden, ...(own !== undefined ? { ownSettings: own } : {}), projectHasBlock };
}
