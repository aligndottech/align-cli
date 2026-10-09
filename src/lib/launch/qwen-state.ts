import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { qwenDir, qwenFolderTrust, qwenSystemDefaultsPath, qwenSystemSettingsPath, type QwenTrust } from './qwen-trust.js';
import { type AlignLocalState, foldLayers, isCanonicalLocalEntry, type Layer, parseJsonc } from './strict-entry.js';

/** The system settings file Qwen would read with no help from align, and what it holds. */
export interface QwenSystemSettings {
  path: string;
  /** Its text; null when it does not exist (or is unreadable). */
  text: string | null;
  /** It exists but could not be read (a directory, no permission). */
  unreadable: boolean;
}

export interface QwenProjectState extends AlignLocalState {
  systemSettings: QwenSystemSettings;
  trust: QwenTrust;
}

/** One launch-cache copy per SOURCE file, as for Gemini, so concurrent launches never share one. */
export const QWEN_COPY_PREFIX = 'qwen-system-settings-';

export function qwenCopyName(source: string): string {
  return `${QWEN_COPY_PREFIX}${createHash('sha256').update(path.resolve(source)).digest('hex').slice(0, 12)}.json`;
}

function readSystem(file: string): QwenSystemSettings {
  try {
    return { path: file, text: readFileSync(file, 'utf8'), unreadable: false };
  } catch (e) {
    return { path: file, text: null, unreadable: (e as { code?: string }).code !== 'ENOENT' };
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const layer = (file: string, text: string | null): Layer => ({ file, servers: parseJsonc(text)?.['mcpServers'] });

/**
 * What Qwen Code would already load here, in its merge order (qwen-code 0.25.0 mergeSettings:
 * system-defaults, user, workspace, system): system-defaults, $QWEN_HOME or ~/.qwen settings,
 * the project's .qwen/settings.json only when the folder is trusted (trust is off by default,
 * which counts as trusted), and the system file. mcpServers merges SHALLOWLY with the system
 * tier last (mergeStrategy "shallow_merge": `{...obj1, ...obj2}`), so the injected system copy
 * replaces any align-local whole: a non-canonical one is overridden, never a conflict
 * (verified: `qwen mcp list` with a user and a workspace align-local shows only align's).
 */
export function readQwenState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
): QwenProjectState {
  const system = readSystem(qwenSystemSettingsPath(env, platform));
  const trust = qwenFolderTrust(cwd, home, env, platform);
  const defaultsPath = env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] ? env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] : qwenSystemDefaultsPath(system.path, platform);
  const userPath = path.join(qwenDir(home, env), 'settings.json');
  const workspacePath = path.join(cwd, '.qwen', 'settings.json');
  const layers: Layer[] = [
    layer(defaultsPath, readText(defaultsPath)),
    layer(userPath, readText(userPath)),
    ...(trust === 'trusted' || trust === 'off' ? [layer(workspacePath, readText(workspacePath))] : []),
    layer(system.path, system.text),
  ];
  const o = { ...opts, platform, host: 'mcpServers' as const };
  const { overridden } = foldLayers(layers, o, () => true);
  // Only the user's own `align` stands in for us; a canonical align-local is replaced whole anyway.
  // Not the workspace's: Qwen holds a workspace server until the user approves it (`qwen mcp list`
  // shows "Pending approval"), so a repo's `align` may not run at all.
  const present = layers.some((l) => l.file !== workspacePath && isCanonicalLocalEntry((l.servers as Record<string, unknown> | undefined)?.['align'], o));
  return { present, overridden, systemSettings: system, trust };
}
