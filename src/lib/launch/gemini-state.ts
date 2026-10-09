import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { geminiDir, geminiFolderTrust, geminiSystemDefaultsPath, geminiSystemSettingsPath, type GeminiTrust } from './gemini-trust.js';
import { type AlignLocalState, foldLayers, type Layer, parseJsonc } from './strict-entry.js';

/** The system settings file Gemini would read with no help from align, and what it holds. */
export interface GeminiSystemSettings {
  path: string;
  /** Its text; null when it does not exist (or is unreadable). */
  text: string | null;
  /** It exists but could not be read (a directory, no permission). */
  unreadable: boolean;
}

export interface GeminiProjectState extends AlignLocalState {
  systemSettings: GeminiSystemSettings;
  trust: GeminiTrust;
}

/**
 * The launch-cache name of the merged copy of one system settings file. One name per SOURCE,
 * so two concurrent launches that read different system files never write the same copy.
 */
export function geminiCopyName(source: string): string {
  return `gemini-system-settings-${createHash('sha256').update(path.resolve(source)).digest('hex').slice(0, 12)}.json`;
}

function readSystem(file: string): GeminiSystemSettings {
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
 * What Gemini CLI would already load here, in its merge order (gemini 0.58.0 mergeSettings:
 * system-defaults, user, workspace, system): system-defaults, ~/.gemini (or $GEMINI_CLI_HOME)
 * settings, the project's .gemini/settings.json ONLY when the folder is trusted (Gemini drops
 * the workspace layer otherwise), and the system file. Files are JSONC, as Gemini reads them.
 * mcpServers merges shallowly with the system tier last, so the injected system copy replaces
 * any align-local whole: a non-canonical one is overridden, never a conflict.
 */
export function readGeminiState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
): GeminiProjectState {
  const system = readSystem(geminiSystemSettingsPath(env, platform));
  const trust = geminiFolderTrust(cwd, home, env, platform);
  const defaultsPath = env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] ? env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] : geminiSystemDefaultsPath(system.path, platform);
  const userPath = path.join(geminiDir(home, env), 'settings.json');
  const workspacePath = path.join(cwd, '.gemini', 'settings.json');
  const layers: Layer[] = [
    layer(defaultsPath, readText(defaultsPath)),
    layer(userPath, readText(userPath)),
    ...(trust === 'trusted' || trust === 'off' ? [layer(workspacePath, readText(workspacePath))] : []),
    layer(system.path, system.text),
  ];
  const state = foldLayers(layers, { ...opts, platform, host: 'mcpServers' }, () => true);
  return { ...state, systemSettings: system, trust };
}
