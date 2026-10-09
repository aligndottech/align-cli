/**
 * The strict "Align is already here" test for the wave A agents (Codex, Gemini CLI, Copilot).
 * Project and workspace files are untrusted input, so an entry stands in for the injected
 * `align-local` only when it is EXACTLY align's own local server: the command, the args, and
 * no other key that could change what runs (env, cwd, url, envFile, a timeout, a filter...).
 *
 * Deliberately separate from project-state.ts's isLocalAlignServer (Claude Code, pi, Cursor),
 * which matches any command line that mentions align and mcp.
 */
export type StrictHost = 'mcpServers' | 'codex' | 'copilot' | 'droid';

export interface CanonicalOptions {
  /** Whether a bare `align mcp` reads the local graph on this machine. */
  localIsDefault: boolean;
  platform: string;
  host: StrictHost;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const sameArgs = (a: unknown, b: string[]): boolean => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/** The keys each host's canonical entry may carry, beyond command and args, and what they must hold. */
const EXTRA: Record<StrictHost, Record<string, (v: unknown) => boolean>> = {
  mcpServers: {},
  // `enabled = false` leaves the server configured and not started: not doing our job.
  codex: { enabled: (v) => v === true },
  // Copilot needs `type`, and a `tools` allowlist: without '*' the tools are not callable.
  copilot: { type: (v) => v === 'local' || v === 'stdio', tools: (v) => sameArgs(v, ['*']) },
  // Factory Droid: `type` is optional and stdio by default; `disabled: true` is configured-but-off.
  droid: { type: (v) => v === 'stdio', disabled: (v) => v === false },
};
const REQUIRED: Record<StrictHost, string[]> = { mcpServers: [], codex: [], copilot: ['type', 'tools'], droid: [] };

export function isCanonicalLocalEntry(entry: unknown, o: CanonicalOptions): boolean {
  if (!isObject(entry)) return false;
  const extra = EXTRA[o.host];
  for (const key of Object.keys(entry)) {
    if (key === 'command' || key === 'args') continue;
    // Own keys of the allowlist only: an entry's `constructor`, `toString` or an own `__proto__`
    // (JSON.parse and smol-toml both return one) must not reach Object.prototype's members.
    if (!Object.hasOwn(extra, key) || !extra[key]!(entry[key])) return false;
  }
  if (!REQUIRED[o.host].every((k) => Object.hasOwn(entry, k))) return false;
  // On win32 an npm global install is align.cmd, which only cmd can spawn (mcp-setup.ts, ALI-1135).
  const [command, prefix] = o.platform === 'win32' ? ['cmd', ['/c', 'align']] : ['align', []];
  if (entry['command'] !== command) return false;
  const accepted = o.localIsDefault ? [['mcp'], ['mcp', '--env', 'local']] : [['mcp', '--env', 'local']];
  return accepted.some((a) => sameArgs(entry['args'], [...prefix, ...a]));
}

/**
 * JSON with `//` and block comments removed, the way Gemini reads its settings and
 * trustedFolders.json (strip-json-comments). Comment markers inside strings are kept. Comments
 * become spaces, so line and column numbers in a parse error still point at the right place.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** JSON or JSONC as an object; null when it is not one. */
export function parseJsonc(text: string | null): Json | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(text));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** What the agent's loaded config layers already hold for Align, decided by the strict test above. */
export interface AlignLocalState {
  /** A layer the agent loads already runs align's own local server (align-local or align). */
  present: boolean;
  /** Files whose `align-local` this launch replaces whole with align's own. */
  overridden: string[];
  /** A file whose `align-local` cannot be replaced whole: no graph this session. */
  conflict?: string;
}

/** One config layer the agent loads, and its servers object (absent when the file has none). */
export interface Layer {
  file: string;
  servers: unknown;
}

/**
 * Fold the loaded layers, in the agent's merge order, into an AlignLocalState.
 * `replaceable(entry)`: whether this launch's injection overwrites EVERY key of a non-canonical
 * align-local (Gemini: always, its system tier replaces the entry whole; Codex: only when it
 * carries nothing beyond command/args/enabled; Copilot: never known, so never).
 */
export function foldLayers(layers: Layer[], o: CanonicalOptions, replaceable: (entry: unknown) => boolean): AlignLocalState {
  const state: AlignLocalState = { present: false, overridden: [] };
  for (const { file, servers } of layers) {
    if (!isObject(servers)) continue;
    if (isCanonicalLocalEntry(servers['align'], o)) state.present = true;
    if (!('align-local' in servers)) continue;
    const ours = servers['align-local'];
    if (isCanonicalLocalEntry(ours, o)) state.present = true;
    else if (replaceable(ours)) state.overridden.push(file);
    else state.conflict ??= file;
  }
  return state;
}
