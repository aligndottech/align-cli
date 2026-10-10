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
import os from 'node:os';
import { backfillChildCommand, type ChildCaller, startBackfillChild } from '../backfill-state.js';
import { CHILD_ENV_KEYS, CHILD_ENV_SECRETS, childEnvValue } from '../launch/mcp-child-env.js';
import { PROVIDER_ENV_VARS } from '../llm-providers.js';
import { inCi } from '../telemetry-ci.js';

/** `--delay 0`: an on-demand run (the person or their agent just asked) has no agent start-up to stay out of the way of. */
export function syncChildArgv(sources: readonly string[], o: { delaySeconds?: number } = {}): string[] {
  return ['sync', '--background', '--delay', String(o.delaySeconds ?? 0), ...sources];
}

/** Names a sync child needs that carry no secret and no routing decision: where things live. Passed as they are. */
const PLAIN_NAMES = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'COMSPEC', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ',
  'USER', 'USERNAME', 'LOGNAME', 'NO_COLOR',
  // A person's own opt-out must reach the child: it sends telemetry (L7) under the same consent as the launcher.
  'DO_NOT_TRACK',
];
/**
 * The ALIGN_* names a sync child reads, and nothing else (checked against src/ by a parity test).
 * No ALIGN_LLM_*, ALIGN_TOKEN or provider setting: a sync makes no LLM call and takes connector tokens from the config file.
 */
export const SYNC_CHILD_ALIGN_NAMES = ['ALIGN_ENV', 'ALIGN_GATEWAY_URL', 'ALIGN_MODEL_CACHE', 'ALIGN_TELEMETRY', 'ALIGN_INGEST_CONCURRENCY', 'ALIGN_DEBUG'] as const;

/** Names whose VALUE rule lives in mcp-child-env.ts (XDG dirs absolute only; proxies and certs kept unless credentialed or relative; NODE_OPTIONS always blank; CI as is). */
const RULED_NAMES = CHILD_ENV_KEYS.filter((k) => !k.startsWith('ALIGN_') && !CHILD_ENV_SECRETS.includes(k) && !PROVIDER_ENV_VARS.includes(k));

/**
 * The environment a background sync child gets: an allow-list, not a copy, and the one list of
 * value rules is mcp-child-env.ts's (so a credentialed proxy URL or a relative certificate path is
 * dropped here exactly as it is for an MCP server). A name that is not listed is not passed, and
 * an empty value is omitted.
 */
export function syncChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PLAIN_NAMES) { const v = env[k]; if (v !== undefined && v !== '') out[k] = v; }
  for (const k of [...RULED_NAMES, ...SYNC_CHILD_ALIGN_NAMES]) {
    const v = childEnvValue(k, env);
    if (v !== '') out[k] = v;
  }
  // The reduced env drops the CI provider's own variables (JENKINS_URL, BUILD_NUMBER...), which is how CI was recognised. Say it outright.
  if (inCi(env)) out['CI'] = 'true';
  return out;
}

export function startSyncChild(
  sources: readonly string[],
  o: { delaySeconds?: number; start?: typeof startBackfillChild; env?: Record<string, string | undefined>; caller?: ChildCaller } = {},
): Promise<{ ok: boolean; pid?: number }> {
  const argv = syncChildArgv(sources, o);
  // The child runs from the home directory, never the folder it was started in: scope is decided by the sync layer,
  // and an unattended run must not read a repo's remote and widen itself to that repo's team.
  return (o.start ?? startBackfillChild)('sync', argv, undefined, backfillChildCommand(argv), o.caller ?? 'mcp', syncChildEnv(o.env ?? process.env), os.homedir());
}
