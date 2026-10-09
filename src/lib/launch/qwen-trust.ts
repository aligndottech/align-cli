import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseJsonc } from './strict-entry.js';

/**
 * Whether Qwen Code will run MCP servers in this folder. Like Gemini (it is a fork), Qwen skips
 * MCP discovery in a folder it does not trust, so the injected align-local is off there too.
 *  - trusted / untrusted: what Qwen will decide.
 *  - off: folder trust is off, which is Qwen's DEFAULT (unlike Gemini), so nothing is disabled.
 *  - unknown: trustedFolders.json is unreadable or invalid.
 */
export type QwenTrust = 'trusted' | 'untrusted' | 'off' | 'unknown';

type Json = Record<string, unknown>;
const LEVELS = new Set(['TRUST_FOLDER', 'TRUST_PARENT', 'DO_NOT_TRUST']);

function readJson(file: string): Json | null {
  try {
    return parseJsonc(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const pathFor = (platform: string) => (platform === 'win32' ? path.win32 : path.posix);

/** Qwen's own default system settings file, used when QWEN_CODE_SYSTEM_SETTINGS_PATH is unset (qwen-code 0.25.0 getSystemSettingsPath). */
export function qwenSystemSettingsPath(env: Record<string, string | undefined>, platform: string): string {
  if (env['QWEN_CODE_SYSTEM_SETTINGS_PATH']) return env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
  if (platform === 'darwin') return '/Library/Application Support/QwenCode/settings.json';
  if (platform === 'win32') return 'C:\\ProgramData\\qwen-code\\settings.json';
  return '/etc/qwen-code/settings.json';
}

/** QWEN_CODE_SYSTEM_DEFAULTS_PATH, else `system-defaults.json` beside the system settings file. */
export function qwenSystemDefaultsPath(systemSettingsPath: string, platform: string): string {
  const p = pathFor(platform);
  return p.join(p.dirname(systemSettingsPath), 'system-defaults.json');
}

/** $QWEN_HOME when set (the directory itself, not $QWEN_HOME/.qwen), else ~/.qwen. */
export function qwenDir(home: string, env: Record<string, string | undefined>): string {
  return env['QWEN_HOME'] ? path.resolve(env['QWEN_HOME']) : path.join(home, '.qwen');
}

const folderTrustSetting = (s: Json | null): unknown => ((s?.['security'] as Json | undefined)?.['folderTrust'] as Json | undefined)?.['enabled'];

/** security.folderTrust.enabled, merged system-defaults < user < system; default OFF (isFolderTrustEnabled: `?? false`). */
function folderTrustEnabled(home: string, env: Record<string, string | undefined>, platform: string): boolean {
  const system = qwenSystemSettingsPath(env, platform);
  const defaults = env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] ? env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] : qwenSystemDefaultsPath(system, platform);
  let enabled = false;
  for (const file of [defaults, path.join(qwenDir(home, env), 'settings.json'), system]) {
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

function normalize(p: string, platform: string): string {
  const abs = pathFor(platform).resolve(p);
  return platform === 'win32' || platform === 'darwin' ? abs.toLowerCase() : abs;
}

/** How deep `rule` sits when it is `location` or an ancestor of it; -1 when it is neither. */
function matchingDepth(rule: string, location: string, platform: string): number {
  const p = pathFor(platform);
  const rel = p.relative(rule, location);
  if (rel.startsWith(`..${p.sep}`) || rel === '..' || p.isAbsolute(rel)) return -1;
  return rule.split(p.sep).filter(Boolean).length;
}

/**
 * Qwen Code 0.25.0's folder-trust verdict for `cwd`, read from its own files and never written
 * (isWorkspaceTrusted, buildTrustPrecedenceRules, resolveTrustRule):
 *  - folder trust off (the default) means nothing is disabled;
 *  - else the DEEPEST matching rule in trustedFolders.json decides (TRUST_PARENT matches the
 *    rule's parent directory), an untrusted rule wins a tie, and no matching rule is untrusted.
 * Qwen also takes a verdict from a connected IDE, which align cannot see (one extra line at most).
 */
export function qwenFolderTrust(cwd: string, home: string, env: Record<string, string | undefined>, platform: string): QwenTrust {
  if (!folderTrustEnabled(home, env, platform)) return 'off';
  const file = env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] ? env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] : path.join(qwenDir(home, env), 'trustedFolders.json');
  if (!existsSync(file)) return 'untrusted';
  const rules = readJson(file);
  if (!rules || !Object.values(rules).every((v) => typeof v === 'string' && LEVELS.has(v))) return 'unknown';

  const p = pathFor(platform);
  const location = normalize(realPath(cwd), platform);
  let deepest = -1;
  let verdict: 'trusted' | 'untrusted' | undefined;
  for (const [raw, level] of Object.entries(rules) as Array<[string, string]>) {
    const effective = normalize(realPath(level === 'TRUST_PARENT' ? p.dirname(raw) : raw), platform);
    const depth = matchingDepth(effective, location, platform);
    if (depth < 0) continue;
    const v = level === 'DO_NOT_TRUST' ? 'untrusted' : 'trusted';
    if (depth > deepest || (depth === deepest && v === 'untrusted')) {
      deepest = depth;
      verdict = v;
    }
  }
  return verdict ?? 'untrusted';
}
