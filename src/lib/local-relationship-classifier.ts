// Stage 2 of local relationship detection: type a candidate edge (found cheaply
// via embeddings) using an LLM with the user's OWN key. Embedding similarity says
// two decisions are related; only an LLM reading both can say HOW (the taxonomy).
// Returns null when no key is configured, so callers degrade to an untyped edge.

export const RELATIONSHIP_TYPES = [
  'supersedes',
  'conflicts_with',
  'contradicts',
  'duplicates',
  'refines',
  'implements',
  'depends_on',
  'relates_to',
] as const;

export type RelationshipType = typeof RELATIONSHIP_TYPES[number];

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
  '(two decisions about the same topic often agree). Use "supersedes" when B replaces A, "relates_to" when merely related.';

function buildUserPrompt(a: DecisionLite, b: DecisionLite): string {
  return `Decision A: ${a.title}. ${a.summary}\n\nDecision B: ${b.title}. ${b.summary}`;
}

export async function classifyRelationship(
  subject: DecisionLite,
  candidate: DecisionLite,
): Promise<ClassifiedRelationship | null> {
  const raw = await callLlm(SYSTEM_PROMPT, buildUserPrompt(subject, candidate));
  if (!raw) return null;
  return parseRelationship(raw);
}

function parseRelationship(text: string): ClassifiedRelationship | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { type?: unknown; confidence?: unknown; reason?: unknown };
    if (typeof obj.type !== 'string' || !RELATIONSHIP_TYPES.includes(obj.type as RelationshipType)) return null;
    const confidence = typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;
    const result: ClassifiedRelationship = { type: obj.type as RelationshipType, confidence };
    if (typeof obj.reason === 'string' && obj.reason.trim()) result.reason = obj.reason.trim();
    return result;
  } catch {
    return null;
  }
}

// Minimal provider call: Anthropic (Haiku) preferred, then OpenAI-compatible.
// Reuses the env-key convention of local-llm.ts; returns null on any failure.
async function callLlm(system: string, user: string): Promise<string | null> {
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey) return callAnthropic(system, user, anthropicKey);
  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey) return callOpenAi(system, user, openaiKey);
  return null;
}

async function callAnthropic(system: string, user: string, key: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env['ALIGN_ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

async function callOpenAi(system: string, user: string, key: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env['ALIGN_OPENAI_MODEL'] ?? 'gpt-4o-mini',
        max_tokens: 256,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}
