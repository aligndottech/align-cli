/**
 * L5: what a sync says, in words a person can act on. One renderer for the CLI line and for the
 * `align_sync` status text, so the two cannot describe the same run differently.
 *
 * Honesty rules (the plan's, verification.md's): an incomplete read says the date it reached and
 * the skip that stopped it; a drain that ran out of budget says how many items are still thin; a
 * refused token says the command to run and nothing about deleting anything; no line carries item
 * content or a raw URL (the SDK's skip details are written to be printed).
 */
import { CAPTURE_SOURCES } from '../capture-sources.js';
import type { CaptureSkip } from '../fetchers/capture.js';
import type { SourceOutcome } from './run-source.js';

const labelOf = (id: string): string => (CAPTURE_SOURCES as Record<string, { label: string }>)[id]?.label ?? id;
const day = (iso: string): string => iso.slice(0, 10);

/** The skip that stopped a read short: the first incomplete kind, in the fetcher's own words. */
function stopper(skips: readonly CaptureSkip[]): CaptureSkip | undefined {
  return skips.find((s) => s.kind !== undefined && s.kind !== 'shape');
}

export function renderOutcome(o: SourceOutcome): string[] {
  const label = labelOf(o.source);
  switch (o.state) {
    case 'not_connected':
    case 'needs_reauth':
    case 'manual':
    case 'locked':
    case 'backfill_running':
      return [`${label}: ${o.message ?? o.state}`];
    case 'error':
      return [`${label}: the sync failed (${o.message ?? 'unknown error'}). Nothing about the saved token changed; the next sync tries again.`];
    case 'ok':
    case 'partial': {
      const since = o.since !== undefined ? ` since ${day(o.since)}` : '';
      const lines = [`${label}: ${o.read} read${since} (${o.created} new, ${o.updated} changed).`];
      if (o.state === 'partial') {
        const why = stopper(o.skips);
        const reached = o.reachedBack !== undefined ? ` Reached back to ${day(o.reachedBack)}; the next sync carries on from there.` : '';
        lines.push(`  Stopped early${why ? `: ${why.count} ${why.detail}` : ''}.${reached}`);
      }
      if (o.scopeNote) lines.push(`  Read ${o.scopeNote}.`);
      if (o.drain && (o.drain.enriched > 0 || o.drain.remaining > 0)) {
        lines.push(`  Discussion: ${o.drain.enriched} read${o.drain.remaining > 0 ? `, ${o.drain.remaining} still to come (the next sync continues)` : ''}.`);
      }
      const rest = o.skips.filter((s) => s !== stopper(o.skips) && !(o.drain?.skips ?? []).includes(s));
      for (const s of rest) lines.push(`  ${s.count} ${s.detail}.`);
      return lines;
    }
  }
}
