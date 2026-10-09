import path from 'node:path';
import { ancestors, fileHasBlock, optionValue, readText } from './layer-files.js';
import { type AlignLocalState, foldLayers, isCanonicalLocalEntry, type Layer, parseJsonc } from './strict-entry.js';

export interface DroidProjectState extends AlignLocalState {
  /** The user runs Droid with their own runtime settings (`--settings` or FACTORY_RUNTIME_SETTINGS_PATH). */
  ownSettings?: string;
  /** An AGENTS.md Droid reads already carries align's managed instructions block. */
  projectHasBlock: boolean;
}

/**
 * What Factory Droid (droid 0.237.0) would already load for align: ~/.factory/mcp.json, and a
 * `.factory/mcp.json` in the cwd or any directory above it (the docs' folder and project
 * levels). Droid keeps ONE definition per server name and the per-process runtime settings win
 * (verified: `droid --settings f mcp list` shows align-local `[runtime]` over a user and a
 * project align-local), so a non-canonical align-local anywhere is overridden, never a conflict.
 *
 * Present: only the user's own canonical `align` in ~/.factory/mcp.json stands in for us. A
 * canonical align-local is replaced by the same thing, and a repo's `align` is repo input.
 */
export function readDroidState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
  passthrough: string[],
): DroidProjectState {
  const userFile = path.join(home, '.factory', 'mcp.json');
  const layer = (file: string): Layer => ({ file, servers: parseJsonc(readText(file))?.['mcpServers'] });
  const user = layer(userFile);
  const layers = [user, ...ancestors(cwd).map((d) => layer(path.join(d, '.factory', 'mcp.json'))).filter((l) => l.file !== userFile)];
  const o = { ...opts, platform, host: 'droid' as const };
  const { overridden } = foldLayers(layers, o, () => true);
  const present = isCanonicalLocalEntry((user.servers as Record<string, unknown> | undefined)?.['align'], o);
  const own = optionValue(passthrough, '--settings') ?? (env['FACTORY_RUNTIME_SETTINGS_PATH'] ? env['FACTORY_RUNTIME_SETTINGS_PATH'] : undefined);
  const blockFiles = [...ancestors(cwd).map((d) => path.join(d, 'AGENTS.md')), path.join(home, '.factory', 'AGENTS.md')];
  return { present, overridden, ...(own !== undefined ? { ownSettings: own } : {}), projectHasBlock: blockFiles.some(fileHasBlock) };
}
