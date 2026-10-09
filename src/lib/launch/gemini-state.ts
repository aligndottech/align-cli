import { readFileSync } from 'node:fs';
import path from 'node:path';
import { geminiDir, geminiFolderTrust, geminiSystemSettingsPath, type GeminiTrust } from './gemini-trust.js';
import { isLocalAlignServer } from './project-state.js';

/** The system settings file Gemini would read with no help from align, and what it holds. */
export interface GeminiSystemSettings {
  path: string;
  /** Its text; null when it does not exist (or is unreadable). */
  text: string | null;
  /** It exists but could not be read (a directory, no permission). */
  unreadable: boolean;
}

export interface GeminiProjectState {
  /** Gemini would already start a local align server (align-local, or align at --env local). */
  projectHasMcp: boolean;
  systemSettings: GeminiSystemSettings;
  trust: GeminiTrust;
}

type Json = Record<string, unknown>;

function readSystem(file: string): GeminiSystemSettings {
  try {
    return { path: file, text: readFileSync(file, 'utf8'), unreadable: false };
  } catch (e) {
    return { path: file, text: null, unreadable: (e as { code?: string }).code !== 'ENOENT' };
  }
}

function servers(text: string | null): Json | undefined {
  if (text === null) return undefined;
  try {
    const parsed = JSON.parse(text) as Json | null;
    return (parsed?.['mcpServers'] ?? undefined) as Json | undefined;
  } catch {
    return undefined;
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * What Gemini CLI would already load here, so the per-session injection never doubles it: the
 * user settings (~/.gemini, or $GEMINI_CLI_HOME), the project's .gemini/settings.json and the
 * system settings file. Plus that system file itself (the adapter merges into a copy of it) and
 * the folder-trust verdict. Read only.
 */
export function readGeminiState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
): GeminiProjectState {
  const system = readSystem(geminiSystemSettingsPath(env, platform));
  const all = [readText(path.join(geminiDir(home, env), 'settings.json')), readText(path.join(cwd, '.gemini', 'settings.json')), system.text].map(servers);
  return {
    projectHasMcp: all.some((s) => s?.['align-local'] !== undefined || isLocalAlignServer(s?.['align'], opts.localIsDefault)),
    systemSettings: system,
    trust: geminiFolderTrust(cwd, home, env, platform),
  };
}
