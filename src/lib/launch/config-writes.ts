import { BACKUP_SUFFIX, safeWriteJson } from '../safe-config-write.js';

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
  kind: 'mcp-entry';
  file: string;
  topKey: string;
  name: string;
  entry: Record<string, unknown>;
  /** Directories at or above this are the user's own and are not checked for links (set by the launcher: the home dir). */
  root?: string;
  /** One extra line after the first write (what the user has to do next). */
  hint?: string;
}

/** Remembers a refused write, so its notice is printed once rather than on every launch. */
export interface RefusedMemo {
  has(file: string): boolean;
  add(file: string): void;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every line goes to `note` (stderr). An entry that is already there, under any shape, is
 * never touched: this adds, it does not update. Throws on an unparseable or contested file;
 * the caller reports it and launches anyway.
 */
export function applyConfigWrite(w: ConfigWrite, note: (line: string) => void, memo?: RefusedMemo): void {
  if (memo?.has(w.file)) return;
  const status = safeWriteJson(
    w.file,
    (cur) => {
      const servers = isObject(cur[w.topKey]) ? (cur[w.topKey] as Json) : {};
      if (w.name in servers) return undefined;
      return { ...cur, [w.topKey]: { ...servers, [w.name]: w.entry } };
    },
    { note, trailingNewline: true, ...(w.root ? { root: w.root } : {}) },
  );
  if (status === 'symlink') memo?.add(w.file);
  if (status === 'written') {
    note(`Added the ${w.name} MCP server to ${w.file} (original kept at ${w.file}${BACKUP_SUFFIX}). Undo: align use --undo`);
    if (w.hint) note(w.hint);
  }
}
