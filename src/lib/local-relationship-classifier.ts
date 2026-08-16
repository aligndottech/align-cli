// Stage 2 of local relationship detection: type a candidate edge (found cheaply
// via embeddings) using an LLM with the user's OWN key. Embedding similarity says
// two decisions are related; only an LLM reading both can say HOW (the taxonomy).
// Uses the shared provider-agnostic resolver in local-llm.ts (any provider).
//
// ALI-414: when classification cannot happen this reports WHY. It previously
// returned a bare null for all three causes, and the caller - unable to tell them
// apart, or apart from "classified, no conflict" - reported `aligned`.

import {
  DECISION_RELATIONSHIPS,
  type DecisionRelationship,
  DETERMINISTIC_TEMPERATURE,
  isDecisionRelationship,
} from '@aligndottech/connector-core';

import { callChat, getUnvettedOllamaModels, hasConfiguredProvider } from './local-llm.js';

// ALI-219: the canonical decision-graph vocabulary is the single source of truth
// (connector-core). The local classifier must only emit types the graph accepts,
// or a local edge is invalid on personal->org sync. Re-exported for callers/tests.
export const RELATIONSHIP_TYPES = DECISION_RELATIONSHIPS;

export type RelationshipType = DecisionRelationship;

export interface ClassifiedRelationship {
  type: RelationshipType;
  confidence: number;
  reason?: string;
}

/**
 * Why a candidate edge could not be typed. Only distinctions the code can actually
 * make: `callChat` cannot tell a timeout from a 429 from an empty body, so there is
 * deliberately no `classifier_timeout`.
 */
export type ClassifierFailureReason =
  /** Nothing to call: no provider key in the environment, no local Ollama. */
  | 'no_llm_key'
  /** A provider IS configured and the call did not come back usable. */
  | 'classifier_error'
  /** The model replied, but with no JSON or a type outside the canonical vocabulary. */
  | 'classifier_unparseable'
  /**
   * Ollama is running, but every installed model is outside the vetted set (ALI-420).
   * Distinct from `no_llm_key` because the remedy is the opposite: this user already has
   * a local provider, and telling them to run one reads as nonsense.
   */
  | 'unvetted_local_model';

export type ClassificationOutcome =
  | { ok: true; relationship: ClassifiedRelationship }
  | { ok: false; reason: ClassifierFailureReason };

interface DecisionLite {
  title: string;
  summary: string;
}

const SYSTEM_PROMPT =
  "You classify how decision B relates to decision A in a software team's decision graph. " +
  `Respond ONLY with compact JSON: {"type": one of [${RELATIONSHIP_TYPES.join(', ')}], "confidence": number 0-1, "reason": short string}. ` +
  'Use "conflicts_with" or "contradicts" ONLY when B genuinely opposes A - high textual similarity alone is NOT a conflict ' +
  '(two decisions about the same topic often agree). Use "supersedes" when B replaces A, "relates" when merely related.';

function buildUserPrompt(a: DecisionLite, b: DecisionLite): string {
  return `Decision A: ${a.title}. ${a.summary}\n\nDecision B: ${b.title}. ${b.summary}`;
}

export async function classifyRelationship(
  subject: DecisionLite,
  candidate: DecisionLite,
): Promise<ClassificationOutcome> {
  // ALI-218/219: pin the shared deterministic temperature so the same decision
  // pair types the same way every run - offline relationship detection must be
  // deterministic, and the value is the one both paths share (connector-core).
  const raw = await callChat(SYSTEM_PROMPT, buildUserPrompt(subject, candidate), {
    temperature: DETERMINISTIC_TEMPERATURE,
  });
  if (!raw) {
    // Order matters: an unvetted local model is a more specific diagnosis than either of
    // the other two, and `hasConfiguredProvider()` is env-only so it cannot see it.
    if (getUnvettedOllamaModels()) return { ok: false, reason: 'unvetted_local_model' };
    return { ok: false, reason: hasConfiguredProvider() ? 'classifier_error' : 'no_llm_key' };
  }
  const relationship = parseRelationship(raw);
  return relationship ? { ok: true, relationship } : { ok: false, reason: 'classifier_unparseable' };
}

function parseRelationship(text: string): ClassifiedRelationship | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { type?: unknown; confidence?: unknown; reason?: unknown };
    // Drop anything outside the canonical vocabulary (the graph would reject it).
    if (!isDecisionRelationship(obj.type)) return null;
    const confidence = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;
    const result: ClassifiedRelationship = { type: obj.type, confidence };
    if (typeof obj.reason === 'string' && obj.reason.trim()) result.reason = obj.reason.trim();
    return result;
  } catch {
    return null;
  }
}

