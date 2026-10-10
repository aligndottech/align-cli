import path from 'node:path';
import { ancestors, optionValue, readText } from './layer-files.js';
import { type AlignLocalState, isCanonicalLocalEntry, parseJsoncTrailingCommas, unreadableMentionsAlign } from './strict-entry.js';

export interface AuggieProjectState extends AlignLocalState {
  /** `<augment cache dir>/settings.json`, the user layer: the one file align adds to. */
  settingsFile: string;
  /** It parses only with its comments stripped: align never rewrites it (the comments would go). */
  commented: boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function strictParse(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Auggie's managed settings: /etc/augment, or %ProgramData%\augment (its bundle, n1e()). */
function managedFile(env: Record<string, string | undefined>, platform: string): string {
  return platform === 'win32'
    ? path.win32.join(env['ProgramData'] || 'C:\\ProgramData', 'augment', 'settings.json')
    : path.posix.join('/etc', 'augment', 'settings.json');
}

/**
 * What Auggie would already load for align (auggie 0.36.0, read from its bundle and checked with
 * `auggie mcp list --json` in a sandbox). Layers: managed, then for the workspace root
 * `.augment/settings.local.json` and `.augment/settings.json`, then the user file
 * `<--augment-cache-dir, default ~/.augment>/settings.json`. A same-named server in a workspace
 * layer replaced the user's. So:
 *  - a canonical align-local (or `align`) in any layer: present, nothing to add;
 *  - a non-canonical align-local in any layer: a conflict. In a repo layer it would replace ours;
 *    in the user file the writer adds and never edits.
 * Files are parsed as Auggie parses them (comments and trailing commas allowed), and a layer align
 * still cannot parse that names align at all is a conflict too (fail closed).
 * The workspace root is the git root unless `-w/--workspace-root` names one: every ancestor of the
 * cwd is read (a superset), plus the named root.
 */
export function readAuggieState(
  cwd: string,
  home: string,
  opts: { localIsDefault: boolean },
  env: Record<string, string | undefined>,
  platform: string,
  passthrough: string[],
): AuggieProjectState {
  const o = { ...opts, platform, host: 'auggie' as const };
  const cacheDir = optionValue(passthrough, '--augment-cache-dir');
  const settingsFile = cacheDir ? path.join(path.resolve(cacheDir), 'settings.json') : path.join(home, '.augment', 'settings.json');
  const root = optionValue(passthrough, '--workspace-root') ?? optionValue(passthrough, '-w');
  const roots = [...(root ? [path.resolve(cwd, root)] : []), ...ancestors(cwd)];
  const files = [
    managedFile(env, platform),
    ...roots.flatMap((d) => [path.join(d, '.augment', 'settings.local.json'), path.join(d, '.augment', 'settings.json')]),
    settingsFile,
  ].filter((f, i, all) => all.indexOf(f) === i);

  const text = readText(settingsFile);
  const state: AuggieProjectState = {
    present: false,
    overridden: [],
    settingsFile,
    // Comments or a trailing comma: Auggie accepts both, and a JSON rewrite would drop them.
    commented: text !== null && text.trim() !== '' && !strictParse(text) && parseJsoncTrailingCommas(text) !== null,
  };
  for (const file of files) {
    const body = file === settingsFile ? text : readText(file);
    const parsed = parseJsoncTrailingCommas(body);
    if (unreadableMentionsAlign(body, parsed)) {
      state.conflict ??= file;
      continue;
    }
    const servers = parsed?.['mcpServers'];
    if (!isObject(servers)) continue;
    if (isCanonicalLocalEntry(servers['align'], o)) state.present = true;
    if (!('align-local' in servers)) continue;
    if (isCanonicalLocalEntry(servers['align-local'], o)) state.present = true;
    else state.conflict ??= file;
  }
  return state;
}
