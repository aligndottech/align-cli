import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Whether Gemini CLI will run MCP servers in this folder. Gemini turns off EVERY MCP server,
 * the injected align-local included, in a folder it does not trust.
 *  - trusted / untrusted: what Gemini will decide.
 *  - off: folder trust is turned off in the user's settings, so nothing is disabled.
 *  - unknown: trustedFolders.json is unreadable or invalid (Gemini itself refuses to start then).
 */
export type GeminiTrust = 'trusted' | 'untrusted' | 'off' | 'unknown';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const LEVELS = new Set(['TRUST_FOLDER', 'TRUST_PARENT', 'DO_NOT_TRUST']);

function readJson(file: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const pathFor = (platform: string) => (platform === 'win32' ? path.win32 : path.posix);

/** Gemini's own default system settings file, used when GEMINI_CLI_SYSTEM_SETTINGS_PATH is unset. */
export function geminiSystemSettingsPath(env: Record<string, string | undefined>, platform: string): string {
  if (env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']) return env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'];
  if (platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json';
  if (platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json';
  return '/etc/gemini-cli/settings.json';
}

/** GEMINI_CLI_SYSTEM_DEFAULTS_PATH, else `system-defaults.json` beside the system settings file. */
export function geminiSystemDefaultsPath(systemSettingsPath: string, platform: string): string {
  const p = pathFor(platform);
  return p.join(p.dirname(systemSettingsPath), 'system-defaults.json');
}

/** ~/.gemini, or $GEMINI_CLI_HOME/.gemini when set. */
export function geminiDir(home: string, env: Record<string, string | undefined>): string {
  return path.join(env['GEMINI_CLI_HOME'] ? env['GEMINI_CLI_HOME'] : home, '.gemini');
}

const folderTrustSetting = (s: Json | null): unknown => ((s?.['security'] as Json | undefined)?.['folderTrust'] as Json | undefined)?.['enabled'];

/** security.folderTrust.enabled, merged system-defaults < user < system as Gemini does; default on. */
function folderTrustEnabled(home: string, env: Record<string, string | undefined>, platform: string): boolean {
  const system = geminiSystemSettingsPath(env, platform);
  const defaults = env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] ? env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH'] : geminiSystemDefaultsPath(system, platform);
  let enabled = true;
  for (const file of [defaults, path.join(geminiDir(home, env), 'settings.json'), system]) {
    const v = folderTrustSetting(readJson(file));
    if (typeof v === 'boolean') enabled = v;
  }
  return enabled;
}

function realPath(p: string): string {
  try {
    return existsSync(p) ? realpathSync(p) : p;
  } catch {
    return p;
  }
}

/** Gemini's normalizePath: absolute, and lower-cased where the filesystem is case-insensitive. */
function normalize(p: string, platform: string): string {
  const abs = pathFor(platform).resolve(p);
  return platform === 'win32' || platform === 'darwin' ? abs.toLowerCase() : abs;
}

/** Gemini's isSubpath: `child` is `parent` or below it. A shared string prefix is not enough. */
function isSubpath(parent: string, child: string, platform: string): boolean {
  const p = pathFor(platform);
  const rel = p.relative(parent, child);
  return !rel.startsWith(`..${p.sep}`) && rel !== '..' && !p.isAbsolute(rel);
}

/**
 * Gemini CLI 0.58.0's folder-trust verdict for `cwd`, read from its own files and never written
 * (packages/core/src/utils/trust.ts, cli/src/config/trustedFolders.ts):
 *  - GEMINI_CLI_TRUST_WORKSPACE=true|false decides outright;
 *  - folder trust turned off in settings means nothing is disabled;
 *  - else the LONGEST matching rule in trustedFolders.json decides, where TRUST_PARENT matches
 *    the rule's parent directory, and no matching rule is untrusted.
 * Gemini also accepts a trust decision from a connected IDE; align cannot see that, so in an IDE
 * terminal this can say untrusted for a folder Gemini will treat as trusted (one extra line).
 */
export function geminiFolderTrust(cwd: string, home: string, env: Record<string, string | undefined>, platform: string): GeminiTrust {
  if (env['GEMINI_CLI_TRUST_WORKSPACE'] === 'true') return 'trusted';
  if (env['GEMINI_CLI_TRUST_WORKSPACE'] === 'false') return 'untrusted';
  if (!folderTrustEnabled(home, env, platform)) return 'off';

  const file = env['GEMINI_CLI_TRUSTED_FOLDERS_PATH'] ? env['GEMINI_CLI_TRUSTED_FOLDERS_PATH'] : path.join(geminiDir(home, env), 'trustedFolders.json');
  if (!existsSync(file)) return 'untrusted';
  const rules = readJson(file);
  if (!rules || !Object.values(rules).every((v) => typeof v === 'string' && LEVELS.has(v))) return 'unknown';

  const p = pathFor(platform);
  const location = normalize(realPath(cwd), platform);
  let longest = -1;
  let verdict: string | undefined;
  for (const [raw, level] of Object.entries(rules) as Array<[string, string]>) {
    const rule = normalize(raw, platform);
    const effective = normalize(realPath(level === 'TRUST_PARENT' ? p.dirname(rule) : rule), platform);
    if (isSubpath(effective, location, platform) && rule.length > longest) {
      longest = rule.length;
      verdict = level;
    }
  }
  return verdict === 'TRUST_FOLDER' || verdict === 'TRUST_PARENT' ? 'trusted' : 'untrusted';
}
