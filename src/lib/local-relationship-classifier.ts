// Stage 2 of local relationship detection: type a candidate edge (found cheaply
// via embeddings) using an LLM with the user's OWN key. Embedding similarity says
// two decisions are related; only an LLM reading both can say HOW (the taxonomy).
// Returns null when no key is configured, so callers degrade to an untyped edge.
// Uses the shared provider-agnostic resolver in local-llm.ts (any provider).

import {
  DECISION_RELATIONSHIPS,
  type DecisionRelationship,
  DETERMINISTIC_TEMPERATURE,
  isDecisionRelationship,
} from '@aligndottech/connector-core';

import { callChat } from './local-llm.js';

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
): Promise<ClassifiedRelationship | null> {
  // ALI-218/219: pin the shared deterministic temperature so the same decision
  // pair types the same way every run - offline relationship detection must be
  // deterministic, and the value is the one both paths share (connector-core).
  const raw = await callChat(SYSTEM_PROMPT, buildUserPrompt(subject, candidate), {
    temperature: DETERMINISTIC_TEMPERATURE,
  });
  if (!raw) return null;
  return parseRelationship(raw);
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

