import path from 'node:path';
import { ancestors, optionValue, readText } from './layer-files.js';
import { type AlignLocalState, isCanonicalLocalEntry, parseJsonc } from './strict-entry.js';

export type AmpProjectState = AlignLocalState & {
  /** The user passes their own `--mcp-config`; Amp takes one. */
  ownMcpConfig?: string;
};

const KEY = 'amp.mcpServers';
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Amp's user settings file: `--settings-file`, else AMP_SETTINGS_FILE, else $XDG_CONFIG_HOME (or ~/.config)/amp/settings.json. */
export function ampSettingsFile(home: string, env: Record<string, string | undefined>, passthrough: string[]): string {
  const flag = optionValue(passthrough, '--settings-file');
  if (flag) return flag;
  if (env['AMP_SETTINGS_FILE']) return env['AMP_SETTINGS_FILE'];
  return path.join(env['XDG_CONFIG_HOME'] ? env['XDG_CONFIG_HOME'] : path.join(home, '.config'), 'amp', 'settings.json');
}

/**
 * What Amp would already load for align (amp 0.0.1791576029, all read as JSONC, which Amp
 * accepts: a settings file with `//` comments lists fine). Measured with `amp mcp list`:
 *  - the user settings file: `--mcp-config` REPLACES a same-named server there (only align's is
 *    listed), so a non-canonical align-local in it is overridden;
 *  - a workspace `.amp/settings.json` (Amp uses the nearest one, up to the git root): a
 *    same-named server there is listed BESIDE the `--mcp-config` one, so which runs is not
 *    known. A non-canonical align-local in any `.amp/settings.json` from the cwd up is a
 *    conflict: no injection. Every ancestor is read, a superset of Amp's own search.
 * Present: the user's own canonical `align` or align-local in the user settings file. A
 * workspace server needs `amp mcp approve` before it runs, so it never stands in for us.
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
  const userFile = ampSettingsFile(home, env, passthrough);
  const servers = (file: string): Json | undefined => {
    const s = parseJsonc(readText(file))?.[KEY];
    return isObject(s) ? s : undefined;
  };
  const user = servers(userFile);
  const state: AmpProjectState = {
    present: isCanonicalLocalEntry(user?.['align'], o) || isCanonicalLocalEntry(user?.['align-local'], o),
    overridden: user && 'align-local' in user && !isCanonicalLocalEntry(user['align-local'], o) ? [userFile] : [],
  };
  for (const dir of ancestors(cwd)) {
    const file = path.join(dir, '.amp', 'settings.json');
    if (file === userFile) continue;
    const ws = servers(file);
    if (ws && 'align-local' in ws && !isCanonicalLocalEntry(ws['align-local'], o)) {
      state.conflict = file;
      break;
    }
  }
  const own = optionValue(passthrough, '--mcp-config');
  if (own !== undefined) state.ownMcpConfig = own;
  return state;
}
