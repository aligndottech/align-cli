/**
 * The local wizard wires agents for the LOCAL graph, and must never overwrite an `align`
 * entry that points somewhere else. A team user's prod entry in ~/.claude.json, their
 * committed .mcp.json or their hooks is theirs; replacing it would silently move their agent
 * to a graph they did not choose. These two helpers are the whole rule, shared by every writer.
 */

/** Called once per file the writer left alone because its align entry targets a non-local env. */
export type OnForeign = (file: string) => void;

/**
 * Whether an align entry (a JSON-stringified server entry, a hook command, a TOML block, a
 * generated plugin) is already pointed at the local graph. No `--env` at all means prod, the
 * default, so absence is NOT local. Matches `--env local`, `"--env", "local"` and `--env=local`.
 */
export function carriesLocalEnv(text: string): boolean {
  return /--env["',\s=]+local\b/.test(text);
}

/** The one stderr line, for every writer: stderr because stdout belongs to what runs next. */
export const reportForeign: OnForeign = (file) => {
  console.error(`align: left ${file} untouched - its align entry points at a team graph, not the local one.`);
};
