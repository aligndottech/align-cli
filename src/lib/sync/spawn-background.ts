/**
 * L5: start `align sync --background ...` as a detached child (Decision 9). Used by `align_sync`
 * (run) here, and by the launch hook and `align_backfill` later. A tool call never runs a bulk
 * fetch in the MCP server's own process: it starts this and returns.
 *
 * "Started" is claimed only after the OS confirmed the child exists (startBackfillChild's rule),
 * stdio is ignored, and the child gets its own process group (`detached`), so closing the
 * terminal or the agent does not take it down; it finishes its current batch and exits.
 */
import { backfillChildCommand, startBackfillChild } from '../backfill-state.js';

/** `--delay 0`: an on-demand run (the person or their agent just asked) has no agent start-up to stay out of the way of. */
export function syncChildArgv(sources: readonly string[], o: { delaySeconds?: number } = {}): string[] {
  return ['sync', '--background', '--delay', String(o.delaySeconds ?? 0), ...sources];
}

export function startSyncChild(
  sources: readonly string[],
  o: { delaySeconds?: number; start?: typeof startBackfillChild } = {},
): Promise<{ ok: boolean; pid?: number }> {
  const argv = syncChildArgv(sources, o);
  return (o.start ?? startBackfillChild)('sync', argv, undefined, backfillChildCommand(argv));
}
