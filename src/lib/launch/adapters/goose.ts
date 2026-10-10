import { alignServerEntry } from '../../mcp-setup.js';
import type { GooseProjectState } from '../goose-state.js';
import { unreadableNote } from './notes.js';
import type { LaunchContext, LaunchSpec } from './claude-code.js';

export interface GooseLaunchContext extends Pick<LaunchContext, 'passthrough'>, GooseProjectState {
  /** A `--recipe` file of the user's that names align-local (its path), else undefined. */
  recipeDefinesAlignLocal?: string;
}

/** goose's root-only options: they print and exit, so there is no session to add to. */
const ROOT_ONLY = new Set(['-h', '--help', '-V', '--version']);
/** `goose session <sub>` commands that open no chat (goose 1.54.0, `goose session --help`). */
const SESSION_SUBCOMMANDS = new Set(['list', 'remove', 'export', 'import', 'diagnostics', 'rename', 'help']);

/**
 * Goose, per session, nothing written (goose 1.54.0, `goose session --help`):
 * `--with-extension '[name:]command args...'` adds a stdio extension for that session, and the
 * user's own extensions still load (Align never passes `--no-profile`). Verified with `goose run`,
 * which takes the same flag, against a stub model: the request carried the user's tools and
 * align-local's. The `align-local:` prefix names it.
 *
 * The chat and the one-shot run take it: with no subcommand (or only session options) Align opens
 * `goose session`, the interactive command; `session`/`s` or `run` the user typed gets it right
 * after; any other subcommand is left alone, with one line. When config.yaml already has align-local,
 * nothing is added: an enabled same-named extension makes goose refuse to start.
 */
export function buildGooseLaunch(c: GooseLaunchContext): LaunchSpec {
  const spec: LaunchSpec = { bin: 'goose', args: [...c.passthrough], env: { ALIGN_WRAPPED: '1' }, files: [] };
  if (c.conflict) {
    return { ...spec, notes: [`${c.conflict} defines its own align-local extension, so Align did not add its graph to Goose. Remove or rename that entry to use the graph.`] };
  }
  if (c.unreadable) {
    return { ...spec, notes: [unreadableNote(c.unreadable)] };
  }
  if (c.recipeDefinesAlignLocal) {
    return { ...spec, notes: [`${c.recipeDefinesAlignLocal} defines its own align-local extension, so Align did not add its graph to Goose. Remove or rename that entry to use the graph.`] };
  }
  if (c.present) return spec;
  const { command, args } = alignServerEntry('mcpServers', 'local') as { command: string; args: string[] };
  const ext = ['--with-extension', `align-local:${[command, ...args].join(' ')}`];
  const [first, ...rest] = c.passthrough;
  if (first === undefined || (first.startsWith('-') && !ROOT_ONLY.has(first))) return { ...spec, args: ['session', ...ext, ...c.passthrough] };
  if (ROOT_ONLY.has(first)) return spec;
  if (first === 'session' || first === 's') {
    return rest[0] !== undefined && SESSION_SUBCOMMANDS.has(rest[0]) ? spec : { ...spec, args: [first, ...ext, ...rest] };
  }
  // `goose run` takes the same flag, and is the form that was checked against a stub model.
  if (first === 'run') return { ...spec, args: [first, ...ext, ...rest] };
  return { ...spec, notes: [`Align adds its graph to \`goose session\` and \`goose run\` only, so \`goose ${first}\` opens without it.`] };
}
