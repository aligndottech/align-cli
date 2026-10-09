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

/**
 * The line shown when a writer left a file alone. It says what happened and how to change it,
 * and nothing about WHICH graph the entry reaches: with no token a bare `align mcp` resolves to
 * the local graph anyway, so calling it a "team graph" would sometimes be false. `global` is a
 * user-level agent config, which `align mcp --setup --env local` can rewrite on request; a
 * project file is the repo's own and is edited by hand.
 */
export function foreignNotice(file: string, scope: 'global' | 'project'): string {
  return scope === 'global'
    ? `Left the existing align entry in ${file} as is. To point this agent at the local graph instead, run: align mcp --setup --env local`
    : `Left the existing align entry in ${file} as is (it is not set to --env local). Edit it by hand to use the local graph.`;
}
