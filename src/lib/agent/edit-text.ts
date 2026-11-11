import type { HookToolInput } from '../hook-payload.js';
import { findLineWriters, isWriterTitle } from '../blame-attribution.js';

export type RelatedDecision = { id: string; title: string; summary?: string; url?: string; status?: 'superseded'; successor?: { id: string; title: string } };

type DecisionLookup = { decisionsBySourceRefs?: (shas: string[], prUrls: string[]) => RelatedDecision[] };

/**
 * The decisions that wrote the lines this edit replaces: `git blame` the lines, then a keyed lookup
 * of the blamed commits and PRs in the graph. Local mode only (the cloud client has no such lookup yet,
 * so it is skipped). Fail-open: any problem returns [] and the hook behaves as it did before.
 */
export async function decisionsThatWroteTheseLines(client: unknown, input: HookToolInput | undefined, cwd: string): Promise<RelatedDecision[]> {
  try {
    const lookup = (client as DecisionLookup).decisionsBySourceRefs;
    if (typeof lookup !== 'function') return [];
    const writers = await findLineWriters(input, cwd);
    if (!writers) return [];
    return lookup.call(client, writers.commitShas, writers.prUrls).filter((d) => isWriterTitle(d.title)).slice(0, 5);
  } catch {
    return [];
  }
}

// The proposed change from a PreToolUse payload: Write sends the full content, Edit a
// new_string, MultiEdit a list of edits. We check the new text against the graph.
export function proposedChangeText(input?: HookToolInput): string {
  if (!input) return '';
  if (typeof input.content === 'string') return input.content;
  if (Array.isArray(input.edits)) return input.edits.map((e) => e.new_string ?? '').join('\n');
  if (typeof input.new_string === 'string') return input.new_string;
  return '';
}
