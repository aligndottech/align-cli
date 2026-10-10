import { parse } from 'smol-toml';
import { BACKUP_SUFFIX, safeWriteJson, safeWriteText } from '../safe-config-write.js';

/**
 * A change to a file in the USER'S agent config that a written-once agent needs (C4): pi and
 * Cursor have no per-session way to be handed an MCP server, so align adds its own entry once.
 * Pure data, so the adapters stay pure; `applyConfigWrite` is the one place that touches disk.
 *
 * Cursor hooks are deliberately not here: Cursor's hooks docs (cursor.com/docs/hooks) confirm
 * only `workspaceOpen` for the CLI and describe the tool hooks as editor-session hooks, so a
 * hooks.json entry written for a CLI launch would not be known to run.
 */
export interface ConfigWrite {
  /** mcp-entry: a key under `topKey` in a JSON file. toml-mcp-entry: a `[mcp_servers.<name>]` table appended to a TOML file. */
  kind: 'mcp-entry' | 'toml-mcp-entry';
  file: string;
  topKey: string;
  name: string;
  entry: Record<string, unknown>;
  /** Directories at or above this are the user's own and are not checked for links (set by the launcher: the home dir). */
  root?: string;
  /** One extra line after the first write (what the user has to do next). */
  hint?: string;
  /** JSON only: the tail of the invalid-JSON message, for a file whose agent reads more than strict JSON (Gemini's settings take comments). */
  invalidJsonAdvice?: string;
}

/**
 * Remembers a refused write, so its notice is printed once rather than on every launch. It is
 * not a permanent no: the path is looked at again each launch, and a file that stops being
 * refused is written and forgotten.
 */
export interface RefusedMemo {
  has(file: string): boolean;
  add(file: string): void;
  remove(file: string): void;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every line goes to `note` (stderr). An entry that is already there, under any shape, is
 * never touched: this adds, it does not update. Throws on an unparseable or contested file;
 * the caller reports it and launches anyway.
 */
export function applyConfigWrite(w: ConfigWrite, note: (line: string) => void, memo?: RefusedMemo): void {
  const quiet = memo?.has(w.file) === true;
  const opts = { note: quiet ? () => undefined : note, ...(w.root ? { root: w.root } : {}) };
  const status = w.kind === 'toml-mcp-entry'
    ? safeWriteText(w.file, (cur) => appendTomlServer(w, cur), { ...opts, markers: tomlMarkers(w.name), tomlTable: [w.topKey, w.name] })
    : safeWriteJson(
    w.file,
    (cur) => {
      const servers = isObject(cur[w.topKey]) ? (cur[w.topKey] as Json) : {};
      if (w.name in servers) return undefined;
      return { ...cur, [w.topKey]: { ...servers, [w.name]: w.entry } };
    },
    { ...opts, trailingNewline: true, ...(w.invalidJsonAdvice ? { invalidJsonAdvice: w.invalidJsonAdvice } : {}) },
  );
  if (status === 'symlink') memo?.add(w.file);
  else if (quiet) memo?.remove(w.file);
  if (status === 'written') {
    note(`Added the ${w.name} MCP server to ${w.file} (original kept at ${w.file}${BACKUP_SUFFIX}). Undo: align use --undo`);
    if (w.hint) note(w.hint);
  }
}

/** The block align owns in a TOML file: `align use --undo` takes out exactly this region. */
export function tomlMarkers(name: string): { start: string; end: string } {
  return { start: `# >>> ${name}: added by align (undo: align use --undo)`, end: `# <<< ${name}` };
}

/** A TOML basic string. JSON's string syntax is valid TOML for the plain ASCII align writes. */
const tomlString = (v: unknown): string => {
  if (typeof v !== 'string' || /[^\x20-\x7e]/.test(v)) throw new Error(`cannot write ${JSON.stringify(v)} as a TOML string`);
  return JSON.stringify(v);
};

/**
 * The new text of a TOML config with `[mcp_servers.<name>]` appended at the end, which keeps
 * every byte the user wrote (comments included). undefined when a server of that name is
 * already there, under any shape. Throws, and so writes nothing, when the file does not parse
 * as TOML, or when the appended table would not land as written (an inline `mcp_servers = {...}`
 * table cannot be extended): the result is parsed back and compared before it is accepted.
 */
function appendTomlServer(w: ConfigWrite, current: string | null): string | undefined {
  const before = current ?? '';
  const { start, end } = tomlMarkers(w.name);
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(before) as Record<string, unknown>;
  } catch {
    throw new Error(`${w.file} is not valid TOML, so align left it alone`);
  }
  const servers = parsed['mcp_servers'];
  if (isObject(servers) && w.name in servers) return undefined;
  // A marker already in the file (a stale one from a write that was cut short, or pasted text)
  // would pair with ours, and undo would take out whatever sits between them.
  if (before.includes(start) || before.includes(end)) {
    throw new Error(`${w.file} already holds an align marker line ("${before.includes(start) ? start : end}"), so align left it alone. Remove that marker line by hand, then run align again`);
  }
  const body = Object.entries(w.entry).map(([k, v]) => `${k} = ${Array.isArray(v) ? `[${v.map(tomlString).join(', ')}]` : tomlString(v)}`);
  const sep = before === '' ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const next = `${before}${sep}${start}\n[mcp_servers.${w.name}]\n${body.join('\n')}\n${end}\n`;
  let landed: unknown;
  try {
    landed = (parse(next) as Record<string, Record<string, unknown> | undefined>)['mcp_servers']?.[w.name];
  } catch {
    landed = undefined;
  }
  if (JSON.stringify(landed) !== JSON.stringify(w.entry)) throw new Error(`align could not add [mcp_servers.${w.name}] to ${w.file} without changing what it means (an inline mcp_servers table?), so it left the file alone`);
  return next;
}
