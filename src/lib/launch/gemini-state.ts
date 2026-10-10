import { readFileSync } from 'node:fs';
import path from 'node:path';
import { geminiSystemFileRejection } from './gemini-system-file.js';
import { geminiDir, geminiFolderTrust, geminiSystemDefaultsPath, geminiSystemSettingsPath, type GeminiTrust } from './gemini-trust.js';
import { type AlignLocalState, foldLayers, type Layer, parseJsonc } from './strict-entry.js';

export interface GeminiProjectState extends Pick<AlignLocalState, 'present' | 'conflict'> {
  /** The user settings file align adds its entry to: $GEMINI_CLI_HOME/.gemini or ~/.gemini, settings.json. */
  settingsFile: string;
  trust: GeminiTrust;
  /** Gemini would not load align-local even with the entry present: where that is set, and what it says. */
  blocked?: { file: string; why: string };
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

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const NAME = 'align-local';
const names = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase().trim()) : null);
const FLAG = '--allowed-mcp-server-names';

/** The user's own flag: Gemini takes it over every settings allowlist (`argv.allowedMcpServerNames ?? settings`). */
function flagBlock(passthrough: string[]): GeminiProjectState['blocked'] {
  const end = passthrough.indexOf('--');
  const args = end < 0 ? passthrough : passthrough.slice(0, end);
  const given: string[] = [];
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === FLAG) {
      seen = true;
      for (i++; i < args.length && !args[i]!.startsWith('-'); i++) given.push(...args[i]!.split(',').map((x) => x.toLowerCase().trim()));
      i--;
    } else if (a.startsWith(`${FLAG}=`)) {
      seen = true;
      given.push(...a.slice(FLAG.length + 1).split(',').map((x) => x.toLowerCase().trim()));
    }
  }
  return seen && !given.includes(NAME) ? { file: FLAG, why: 'it does not list align-local' } : undefined;
}

/**
 * Settings that make Gemini drop align-local even when the entry is there (0.63.0): mcp.excluded
 * is a union over the loaded layers, mcp.allowed an intersection, admin.mcp.enabled=false turns
 * every server off. NOT read: ~/.gemini/mcp-server-enablement.json (its format was not checked).
 */
function blockedBy(files: Array<{ file: string; settings: Json | null }>, passthrough: string[]): GeminiProjectState['blocked'] {
  const flag = flagBlock(passthrough);
  if (flag) return flag;
  for (const { file, settings } of files) {
    const mcp = settings?.['mcp'];
    if (isObject(mcp) && names(mcp['excluded'])?.includes(NAME)) return { file, why: 'mcp.excluded lists align-local' };
    const admin = settings?.['admin'];
    if (isObject(admin) && isObject(admin['mcp']) && admin['mcp']['enabled'] === false) return { file, why: 'admin.mcp.enabled is false' };
  }
  for (const { file, settings } of files) {
    const mcp = settings?.['mcp'];
    const allowed = isObject(mcp) ? names(mcp['allowed']) : null;
    if (allowed && !allowed.includes(NAME)) return { file, why: 'mcp.allowed does not list align-local' };
  }
  return undefined;
}

/**
 * What Gemini CLI would already load here, in its merge order (gemini 0.63.0 mergeSettings:
 * system-defaults, user, workspace, system; mcpServers merges shallowly, LAST layer wins per name):
 *  - system-defaults and system files, ONLY when Gemini will read them (root-owned tree, see
 *    gemini-system-file.ts; `rejects` is a parameter so a test can name the answer);
 *  - the user settings file;
 *  - the project's .gemini/settings.json. It is ALWAYS folded for the conflict check, because
 *    Gemini also trusts a folder through a connected IDE, which align cannot see; a false
 *    conflict in a folder that really is untrusted is harmless. It counts as "present" only when
 *    align's own verdict is trusted/off, and its mcp.allowed/excluded only then too.
 * Repo config is untrusted input: per name only the effective (last) entry counts, so a repo
 * `align` that replaces the user's canonical one is a conflict naming the repo file.
 * Files are JSONC, as Gemini reads them. Align adds an entry; it never edits one that is there.
 */
export function readGeminiState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
  rejects: (file: string, platform: string) => string | null = geminiSystemFileRejection,
  passthrough: string[] = [],
): GeminiProjectState {
  const systemPath = geminiSystemSettingsPath(env, platform);
  const defaultsPath = env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] ? env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] : geminiSystemDefaultsPath(systemPath, platform);
  const settingsFile = path.join(geminiDir(home, env), 'settings.json');
  const workspacePath = path.join(cwd, '.gemini', 'settings.json');
  const trust = geminiFolderTrust(cwd, home, env, platform, rejects);
  const workspaceLoads = trust === 'trusted' || trust === 'off';
  const text = (file: string, isSystem: boolean): string | null => (isSystem && rejects(file, platform) !== null ? null : readText(file));
  const sources = [
    { file: defaultsPath, text: text(defaultsPath, true), live: true },
    { file: settingsFile, text: text(settingsFile, false), live: true },
    { file: workspacePath, text: readText(workspacePath), live: workspaceLoads },
    { file: systemPath, text: text(systemPath, true), live: true },
  ];
  const parsed = sources.map((s) => ({ ...s, json: parseJsonc(s.text) }));
  const layers: Layer[] = parsed.map((s) => ({ file: s.file, servers: s.json?.['mcpServers'] }));
  const o = { ...opts, platform, host: 'mcpServers' as const };
  const { present, conflict } = foldLayers(layers, o, () => false, { lastWins: true, countsAsPresent: (f) => f !== workspacePath || workspaceLoads });
  const blocked = blockedBy(parsed.filter((s) => s.live).map((s) => ({ file: s.file, settings: s.json })), passthrough);
  return { present, ...(conflict !== undefined ? { conflict } : {}), settingsFile, trust, ...(blocked ? { blocked } : {}) };
}
