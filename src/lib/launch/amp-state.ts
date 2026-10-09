import path from 'node:path';
import { ancestors, optionValue, readText } from './layer-files.js';
import { type AlignLocalState, isCanonicalLocalEntry, parseJsonc } from './strict-entry.js';

export interface AmpProjectState extends AlignLocalState {
  /** The user settings file Amp reads this session: the one align adds to. */
  settingsFile: string;
  /** It parses only with its comments stripped: align never rewrites it (the comments would go). */
  commented: boolean;
}

const KEY = 'amp.mcpServers';
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Amp's user settings file: `--settings-file`, else AMP_SETTINGS_FILE, else $XDG_CONFIG_HOME (or ~/.config)/amp/settings.json. */
export function ampSettingsFile(home: string, env: Record<string, string | undefined>, passthrough: string[]): string {
  const flag = optionValue(passthrough, '--settings-file');
  if (flag) return path.resolve(flag);
  if (env['AMP_SETTINGS_FILE']) return path.resolve(env['AMP_SETTINGS_FILE']);
  return path.join(env['XDG_CONFIG_HOME'] ? env['XDG_CONFIG_HOME'] : path.join(home, '.config'), 'amp', 'settings.json');
}

function strictParse(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * What Amp would already load for align (amp 0.0.1791576029; it reads its settings as JSONC):
 *  - the user settings file align adds to: a canonical `align` or align-local there is present;
 *    a non-canonical align-local is a conflict, because the writer adds and never edits;
 *  - a workspace `.amp/settings.json` (Amp uses the nearest one, up to the git root; every
 *    ancestor is read here, a superset): a non-canonical align-local there is a conflict. A
 *    workspace server waits for `amp mcp approve`, so it never stands in for us.
 */
export function readAmpState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
  passthrough: string[],
): AmpProjectState {
  const o = { ...opts, platform, host: 'mcpServers' as const };
  const settingsFile = ampSettingsFile(home, env, passthrough);
  const servers = (text: string | null): Json | undefined => {
    const s = parseJsonc(text)?.[KEY];
    return isObject(s) ? s : undefined;
  };
  const text = readText(settingsFile);
  const user = servers(text);
  const state: AmpProjectState = {
    present: isCanonicalLocalEntry(user?.['align'], o) || isCanonicalLocalEntry(user?.['align-local'], o),
    overridden: [],
    settingsFile,
    commented: text !== null && text.trim() !== '' && !strictParse(text) && parseJsonc(text) !== null,
  };
  if (user && 'align-local' in user && !isCanonicalLocalEntry(user['align-local'], o)) state.conflict = settingsFile;
  for (const dir of ancestors(cwd)) {
    const file = path.join(dir, '.amp', 'settings.json');
    if (file === settingsFile) continue;
    const ws = servers(readText(file));
    if (ws && 'align-local' in ws && !isCanonicalLocalEntry(ws['align-local'], o)) {
      state.conflict ??= file;
      break;
    }
  }
  return state;
}
