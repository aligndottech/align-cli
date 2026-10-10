import { readFileSync } from 'node:fs';
import path from 'node:path';
import { geminiSystemFileRejection } from './gemini-system-file.js';
import { geminiDir, geminiFolderTrust, geminiSystemDefaultsPath, geminiSystemSettingsPath, type GeminiTrust } from './gemini-trust.js';
import { type AlignLocalState, foldLayers, isCanonicalLocalEntry, type Layer, parseJsonc } from './strict-entry.js';

export interface GeminiProjectState extends Pick<AlignLocalState, 'present' | 'conflict'> {
  /** The user settings file align adds its entry to: $GEMINI_CLI_HOME/.gemini or ~/.gemini, settings.json. */
  settingsFile: string;
  trust: GeminiTrust;
  /** Gemini would not load align-local even with the entry present: where that is set, and what it says. */
  blocked?: { file: string; why: string };
  /** A repo file defines an `align` server of its own, with no user `align` behind it: Gemini runs it next to ours. */
  repoAlign?: string;
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


type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const NAME = 'align-local';
const names = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
const FLAGS = ['--allowed-mcp-server-names', '--allowedMcpServerNames'];

/**
 * The user's own --allowed-mcp-server-names. It REPLACES every settings allowlist and DROPS
 * excluded (measured, 0.63.0). `--flag=a,b` gives both names; the space form gives only the FIRST
 * value (`--flag other align-local` blocked align-local). null when the flag is absent.
 */
function flagList(passthrough: string[]): { flag: string; list: string[] } | null {
  const end = passthrough.indexOf('--');
  const args = end < 0 ? passthrough : passthrough.slice(0, end);
  let found: { flag: string; list: string[] } | null = null;
  args.forEach((a, i) => {
    const hit = FLAGS.find((f) => a === f || a.startsWith(`${f}=`));
    if (!hit) return;
    const raw = a === hit ? args[i + 1] : a.slice(hit.length + 1);
    found = { flag: hit, list: raw === undefined || (a === hit && raw.startsWith('-')) ? [] : raw.split(',') };
  });
  return found;
}

/**
 * Settings that make a live Gemini session drop align-local although the entry is there, copied
 * from McpClientManager.isBlockedBySettings (0.63.0, NOT `gemini mcp list`, which disagrees):
 * EXACT-case matching, no trimming; excluded is a union over the loaded layers; allowed is an
 * intersection across layers and an EMPTY result allows all. Not a blocker for a live session
 * (measured): admin.mcp.enabled in user or workspace settings. NOT read: the system tier's
 * admin.mcp.enabled and ~/.gemini/mcp-server-enablement.json - UNVERIFIED.
 */
function blockedBy(files: Array<{ file: string; settings: Json | null }>, passthrough: string[]): GeminiProjectState['blocked'] {
  const flag = flagList(passthrough);
  if (flag) {
    return flag.list.length === 0 || flag.list.includes(NAME) ? undefined : { file: flag.flag, why: 'it does not list align-local' };
  }
  for (const { file, settings } of files) {
    const mcp = settings?.['mcp'];
    if (isObject(mcp) && names(mcp['excluded'])?.includes(NAME)) return { file, why: 'mcp.excluded lists align-local' };
  }
  let allowed: string[] | null = null;
  let from = '';
  for (const { file, settings } of files) {
    const mcp = settings?.['mcp'];
    const list = isObject(mcp) ? names(mcp['allowed']) : null;
    if (!list) continue;
    allowed = allowed === null ? list : allowed.filter((x) => list.includes(x));
    from = file;
  }
  if (allowed !== null && allowed.length > 0 && !allowed.includes(NAME)) {
    // Name the layer that narrowed it last; with one layer that is the only one.
    return { file: from, why: 'mcp.allowed does not list align-local' };
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
  // The effective `align` is the last layer that names it. From a LOADED workspace, and not
  // already the conflict, it is something the repo chose and the user did not.
  const aligns = layers.filter((l) => isObject(l.servers) && 'align' in l.servers);
  const effective = aligns[aligns.length - 1];
  const repoAlign = workspaceLoads && effective?.file === workspacePath && conflict !== workspacePath
    && !isCanonicalLocalEntry((effective.servers as Json)['align'], o) ? workspacePath : undefined;
  const blocked = blockedBy(parsed.filter((s) => s.live).map((s) => ({ file: s.file, settings: s.json })), passthrough);
  return { present, ...(conflict !== undefined ? { conflict } : {}), settingsFile, trust, ...(blocked ? { blocked } : {}), ...(repoAlign ? { repoAlign } : {}) };
}
