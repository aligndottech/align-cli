import { foreignNotice } from '../foreign-env.js';
import { BACKUP_SUFFIX, safeWriteJson } from '../safe-config-write.js';
import { writeUserHooks } from '../user-hooks.js';

/**
 * A change to a file in the USER'S agent config that a written-once agent needs (C4): pi and
 * Cursor have no per-session way to be handed an MCP server, so align adds its own entry once.
 * Pure data, so the adapters stay pure; `applyConfigWrite` is the one place that touches disk.
 */
export type ConfigWrite =
  | { kind: 'mcp-entry'; file: string; topKey: string; name: string; entry: Record<string, unknown> }
  | { kind: 'cursor-hooks'; file: string };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every line goes to `note` (stderr). An entry that is already there, under any shape, is
 * never touched: this adds, it does not update. Throws on an unparseable or contested file;
 * the caller reports it and launches anyway.
 */
export function applyConfigWrite(w: ConfigWrite, note: (line: string) => void): void {
  if (w.kind === 'mcp-entry') {
    const status = safeWriteJson(
      w.file,
      (cur) => {
        const servers = isObject(cur[w.topKey]) ? (cur[w.topKey] as Json) : {};
        if (w.name in servers) return undefined;
        return { ...cur, [w.topKey]: { ...servers, [w.name]: w.entry } };
      },
      { note, trailingNewline: true },
    );
    if (status === 'written') note(`Added the ${w.name} MCP server to ${w.file} (original kept at ${w.file}${BACKUP_SUFFIX}). Undo: align use --undo`);
    return;
  }
  if (writeUserHooks({ host: 'cursor', path: w.file }, 'local', (f) => note(foreignNotice(f, 'global')))) {
    note(`Added Align's pre-edit check to ${w.file} (original kept at ${w.file}${BACKUP_SUFFIX}). Undo: align use --undo`);
  }
}
