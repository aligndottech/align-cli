/**
 * L5: start `align sync --background ...` as a detached child (Decision 9). Used by `align_sync`
 * (run) here, and by the launch hook and `align_backfill` later. A tool call never runs a bulk
 * fetch in the MCP server's own process: it starts this and returns.
 *
 * "Started" is claimed only after the OS confirmed the child exists (startBackfillChild's rule),
 * stdio is ignored, and the child gets its own process group (`detached`), so closing the
 * terminal or the agent does not take it down; it finishes its current batch and exits.
 *
 * `caller` names who asked: 'mcp' (the default) marks the child as an agent's, so any scope it writes waits for a person; the launch hook
 * passes 'launcher' for the person's own background refresh, which must not carry that mark.
 */
import { backfillChildCommand, type ChildCaller, startBackfillChild } from '../backfill-state.js';

/** `--delay 0`: an on-demand run (the person or their agent just asked) has no agent start-up to stay out of the way of. */
export function syncChildArgv(sources: readonly string[], o: { delaySeconds?: number } = {}): string[] {
  return ['sync', '--background', '--delay', String(o.delaySeconds ?? 0), ...sources];
}

/** Names a sync child needs: where things live, how to reach the network, and align's own switches. */
const CHILD_ENV_EXACT = new Set([
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'COMSPEC', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ',
  'USER', 'USERNAME', 'LOGNAME', 'NO_COLOR', 'DO_NOT_TRACK',
  // Where Node sends traffic and which certificates it trusts: the user's own, so a corporate proxy still works.
  'NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);
const CHILD_ENV_PREFIX = ['XDG_', 'LC_', 'ALIGN_'];
/** Never passed even when a prefix above would allow it: a credential the sync job does not use (it reads tokens from the config file). */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;
/** Launcher state that means something only inside the launching process. */
const LAUNCHER_ONLY = new Set(['ALIGN_WRAPPED', 'ALIGN_NO_LAUNCH', 'ALIGN_LAUNCH_TRACE', 'ALIGN_LAUNCH_DRY_RUN']);

/**
 * The environment a background sync child gets from the launcher: an allow-list, not a copy. The
 * launcher's own environment holds whatever the coding agent needs (provider keys, cloud
 * credentials, a repo `.env`), and a sync job reads none of it: it takes connector tokens from the
 * config file and makes no LLM call. A name that is not listed is not passed.
 */
export function syncChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || LAUNCHER_ONLY.has(k) || SECRET_NAME.test(k)) continue;
    if (CHILD_ENV_EXACT.has(k) || CHILD_ENV_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

export function startSyncChild(
  sources: readonly string[],
  o: { delaySeconds?: number; start?: typeof startBackfillChild; env?: Record<string, string | undefined>; caller?: ChildCaller } = {},
): Promise<{ ok: boolean; pid?: number }> {
  const argv = syncChildArgv(sources, o);
  return (o.start ?? startBackfillChild)('sync', argv, undefined, backfillChildCommand(argv), o.caller ?? 'mcp', syncChildEnv(o.env ?? process.env));
}
