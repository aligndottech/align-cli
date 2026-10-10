/**
 * One `similar[]` entry -> the edge to write, ported from the brain's
 * `resolve_similar_relationships` (verdict_resolution.py, ALI-637) for a single entry.
 *
 * A non-verdict type passes through. `incompatible` goes through resolveIncompatiblePair with the
 * new decision as side A; the model's `replaced` side becomes the replacing id. A `supersedes` the
 * resolver orients candidate -> new cannot be written on a new-vs-candidate edge, so it degrades
 * to `conflicts_with` with the same reason the brain appends.
 */
import type { ParsedRelationshipItem } from './relationship-contract.js';
import { type PairSide, resolveIncompatiblePair } from './resolve-pair.js';

export const NEW_DECISION_REF = '__new_decision__';
export const DIRECTION_FALLBACK_REASON =
  'existing decision is more recent; supersession toward the new decision is not expressible on this path';

export interface ResolvedItem {
  type: string;
  confidence: number;
  reason: string;
}

export function resolveSimilarItem(item: ParsedRelationshipItem, newSide: PairSide, candidate: PairSide): ResolvedItem | null {
  if (item.type !== 'incompatible') return { type: item.type, confidence: item.confidence, reason: item.reason };
  const replacingId = item.replaced === 'new' ? newSide.id : item.replaced === 'existing' ? candidate.id : null;
  const resolution = resolveIncompatiblePair(newSide, candidate, replacingId);
  if (resolution === null) return null;
  if (resolution.type === 'supersedes' && resolution.fromId !== newSide.id) {
    return { type: 'conflicts_with', confidence: item.confidence, reason: item.reason ? `${item.reason}; ${DIRECTION_FALLBACK_REASON}` : DIRECTION_FALLBACK_REASON };
  }
  return { type: resolution.type, confidence: item.confidence, reason: item.reason };
}
