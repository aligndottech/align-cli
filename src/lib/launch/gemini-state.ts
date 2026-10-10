import { readFileSync } from 'node:fs';
import path from 'node:path';
import { geminiSystemFileRejection } from './gemini-system-file.js';
import { geminiDir, geminiFolderTrust, geminiSystemDefaultsPath, geminiSystemSettingsPath, type GeminiTrust } from './gemini-trust.js';
import { type AlignLocalState, foldLayers, type Layer, parseJsonc } from './strict-entry.js';

export interface GeminiProjectState extends Pick<AlignLocalState, 'present' | 'conflict'> {
  /** The user settings file align adds its entry to: $GEMINI_CLI_HOME/.gemini or ~/.gemini, settings.json. */
  settingsFile: string;
  trust: GeminiTrust;
}

/**
 * The launch-cache prefix of the merged system-settings copies align 0.49 to 0.51 wrote. Gemini
 * skips such a copy (see gemini-system-file.ts), so nothing writes one now; the prefix is kept so
 * the old ones, which hold the admin's settings, are aged out of the cache.
 */
export const COPY_PREFIX = 'gemini-system-settings-';

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const layer = (file: string, text: string | null): Layer => ({ file, servers: parseJsonc(text)?.['mcpServers'] });

/**
 * What Gemini CLI would already load here, in its merge order (gemini 0.63.0 mergeSettings:
 * system-defaults, user, workspace, system; mcpServers merges shallowly, later wins):
 *  - system-defaults and system files, ONLY when Gemini will read them (root-owned tree, see
 *    gemini-system-file.ts; `rejects` is a parameter so a test can name the answer);
 *  - the user settings file;
 *  - the project's .gemini/settings.json ONLY when the folder is trusted (Gemini drops the
 *    workspace layer otherwise). Repo config is untrusted input: a workspace align-local that is
 *    not align's exact entry outranks the user file, so it is a conflict, never replaced.
 * Files are JSONC, as Gemini reads them. A non-canonical align-local anywhere that Gemini loads
 * is a conflict: align adds an entry, it never edits one that is there.
 */
export function readGeminiState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
  rejects: (file: string, platform: string) => string | null = geminiSystemFileRejection,
): GeminiProjectState {
  const systemPath = geminiSystemSettingsPath(env, platform);
  const defaultsPath = env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] ? env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] : geminiSystemDefaultsPath(systemPath, platform);
  const settingsFile = path.join(geminiDir(home, env), 'settings.json');
  const workspacePath = path.join(cwd, '.gemini', 'settings.json');
  const trust = geminiFolderTrust(cwd, home, env, platform);
  const system = (file: string): Layer => layer(file, rejects(file, platform) === null ? readText(file) : null);
  const layers: Layer[] = [
    system(defaultsPath),
    layer(settingsFile, readText(settingsFile)),
    ...(trust === 'trusted' || trust === 'off' ? [layer(workspacePath, readText(workspacePath))] : []),
    system(systemPath),
  ];
  const o = { ...opts, platform, host: 'mcpServers' as const };
  const { present, conflict } = foldLayers(layers, o, () => false);
  return { present, ...(conflict !== undefined ? { conflict } : {}), settingsFile, trust };
}
