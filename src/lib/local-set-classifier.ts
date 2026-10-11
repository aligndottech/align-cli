/**
 * The v1 local relationship classifier (ALIGN_DETECTOR=v1): ONE model call per check over every
 * candidate, using the shared detector prompt (src/detector), parsed with the shared contract, and
 * with `incompatible` resolved to `supersedes` or `conflicts_with` by the deterministic resolver,
 * never by the model's own label.
 *
 * Authorship: the local graph stores no author per decision, so every side is passed with
 * author null. The resolver reads null as UNKNOWN, and two unknown authors are never the same
 * author, so the same-author supersession rule cannot fire locally; only a replacement claim
 * that agrees with the clock can earn `supersedes`. Standing is also null on both sides, which
 * the resolver treats as equal.
 *
 * A candidate the model omits, or whose entry fails the contract, gets `relation: null`: it was
 * judged and has no typed relationship. A whole-call failure is reported once, for the set.
 */
import { DETERMINISTIC_TEMPERATURE } from '@aligndottech/connector-core';
import { parseRelationshipItem } from '../detector/relationship-contract.js';
import { buildV1SystemPrompt, buildV1UserPrompt, v1MaxTokens } from '../detector/relationship-prompt.js';
import { NEW_DECISION_REF, resolveSimilarItem } from '../detector/similar-item.js';
import { callChatDetailed, type LlmFailure } from './local-llm.js';
import { type ClassifierFailureReason, failureReason } from './local-relationship-classifier.js';

export interface SetSubject {
  title: string;
  summary: string;
  /** null for a proposed change: nothing has decided it yet, so the resolver refuses supersedes. */
  decidedAt: string | null;
  platform?: string | null;
}

export interface SetCandidate {
  id: string;
  title: string;
  summary: string;
  similarity: number;
  platform?: string | null;
  decidedAt: string | null;
  status?: string | null;
}

export interface SetVerdict {
  /** The edge to write, or null when the model gave this candidate no relationship. */
  relation: string | null;
  confidence: number;
  reason?: string;
}

export type SetOutcome =
  | { ok: true; verdicts: SetVerdict[] }
  | { ok: false; reason: ClassifierFailureReason; failure?: LlmFailure };

type Call = typeof callChatDetailed;

/** The `similar` array from the model's answer, or null when there is none to read. */
function similarEntries(text: string): unknown[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const rel = record['relationships'];
  const similar = typeof rel === 'object' && rel !== null ? (rel as Record<string, unknown>)['similar'] : record['similar'];
  return Array.isArray(similar) ? similar : null;
}

/** 1-based ordinal as printed in the prompt, as a number or a digit string; anything else is null. */
function ordinal(value: unknown, count: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= count ? n : null;
}

export async function classifyCandidateSet(subject: SetSubject, candidates: readonly SetCandidate[], call: Call = callChatDetailed): Promise<SetOutcome> {
  if (!candidates.length) return { ok: true, verdicts: [] };
  const maxTokens = v1MaxTokens(candidates.length);
  const result = await call(
    buildV1SystemPrompt(),
    (windowTokens: number) => buildV1UserPrompt(subject, candidates, windowTokens, maxTokens),
    { temperature: DETERMINISTIC_TEMPERATURE, maxTokens },
  );
  if (!result.ok) return { ok: false, reason: failureReason(result.failure), failure: result.failure };
  const entries = similarEntries(result.text);
  if (entries === null) return { ok: false, reason: 'classifier_unparseable' };

  const verdicts: SetVerdict[] = candidates.map((c) => ({ relation: null, confidence: c.similarity }));
  const seen = new Set<number>();
  const newSide = { id: NEW_DECISION_REF, decidedAt: subject.decidedAt, author: null };
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const ref = ordinal((entry as Record<string, unknown>)['decision_ref'], candidates.length);
    if (ref === null || seen.has(ref)) continue;
    seen.add(ref);
    // The shared schema asks for "reasons": [...]; the contract parser reads one "reason" string.
    const raw = entry as Record<string, unknown>;
    const reasons = Array.isArray(raw['reasons']) ? raw['reasons'].filter((r): r is string => typeof r === 'string') : [];
    const item = parseRelationshipItem(JSON.stringify(raw['reason'] === undefined && reasons.length ? { ...raw, reason: reasons.join('; ') } : raw), 'v1Candidate');
    if (item === null) continue;
    const c = candidates[ref - 1]!;
    const resolved = resolveSimilarItem(item, newSide, { id: c.id, decidedAt: c.decidedAt, author: null, status: c.status ?? null });
    if (resolved === null) continue;
    verdicts[ref - 1] = { relation: resolved.type, confidence: resolved.confidence, ...(resolved.reason ? { reason: resolved.reason } : {}) };
  }
  return { ok: true, verdicts };
}
