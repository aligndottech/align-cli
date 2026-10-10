/**
 * The v1 detector's prompt: the shared base (three byte-exact slices of the hosted ANALYSIS_RULES,
 * in relationship-prompt.v1.json) wrapped in a CLI head, plus the user prompt listing every
 * candidate in ONE call. The user prompt mirrors the hosted single-path shape (NEW DECISION,
 * SIMILAR DECISIONS numbered, never an id) so one prompt revision means the same thing on both.
 *
 * What the local graph cannot supply is left out rather than invented: there is no author column,
 * so no By line is ever rendered, and the resolver treats every local author as unknown.
 *
 * Pure: no I/O.
 */
import template from './relationship-prompt.v1.json' with { type: 'json' };
import { isRetired, parseDecidedAt } from './resolve-pair.js';
import { charsForTokens, estimateTokens } from '../lib/token-estimate.js';

export interface V1Subject {
  title: string;
  summary: string;
  decidedAt?: string | null;
  platform?: string | null;
}

export interface V1Candidate {
  title: string;
  summary: string;
  similarity: number;
  platform?: string | null;
  decidedAt?: string | null;
  status?: string | null;
}

export const V1_TEMPLATE_REVISION = template.sourceSha256;

const HEAD = 'You are an AI that analyzes decisions for conflicts and relationships.\n\n'
  + 'Analyze and respond in JSON format:\n{\n  "relationships": {\n    "similar": [\n      ';
const TAIL = '\n    ]\n  }\n}\n\n'
  + 'Give an entry only for a SIMILAR DECISION that is related to the NEW DECISION. Omit any that are not; an omitted decision gets no relationship.\n\n';

export function buildV1SystemPrompt(): string {
  const { itemSchema, rules, types } = template.sections;
  return `${HEAD}${itemSchema}${TAIL}${rules}\n\n${types}`;
}

const day = (value: string | null | undefined): string | null => parseDecidedAt(value)?.toISOString().slice(0, 10) ?? null;

/** max(n * 512, 2048), capped at 8192 - the brain's formula (plan Decision 6). */
export function v1MaxTokens(candidateCount: number): number {
  return Math.min(Math.max(candidateCount * 512, 2048), 8192);
}

export function buildV1UserPrompt(subject: V1Subject, candidates: readonly V1Candidate[], windowTokens: number, outputTokens: number): string {
  const subjectDay = day(subject.decidedAt);
  const head = `Analyze this decision for relationships.\n\nNEW DECISION:\nTitle: ${subject.title}\nSummary: `;
  const headTail = `\nPlatform: ${(subject.platform ?? 'cli').toLowerCase()}\n${subjectDay ? `Decided: ${subjectDay}\n` : ''}`
    + '\nCONTEXT:\n- The Decided/By lines are facts captured from the source tools. Use them as context for whether two texts address the same subject; do not infer facts that are not shown.\n\n'
    + 'SIMILAR DECISIONS:\n';
  const lines = candidates.map((c, i) => {
    const bits: string[] = [];
    if (isRetired(c.status)) bits.push('RETIRED');
    const d = day(c.decidedAt);
    if (d) bits.push(`decided ${d}`);
    const facts = bits.length ? ` [${bits.join(' | ')}]` : '';
    return `${i + 1}. ${c.title} (similarity: ${c.similarity.toFixed(2)}) [Platform: ${(c.platform ?? 'unknown').toLowerCase()}]${facts}\n   `;
  });
  // Titles and labels are never cut; the summaries share what is left of the window equally.
  const fixed = estimateTokens(buildV1SystemPrompt()) + outputTokens + estimateTokens(head + headTail + lines.join('\n\n'));
  const perSummary = charsForTokens(Math.floor(Math.max(0, windowTokens - fixed) / (candidates.length + 1)));
  const cut = (s: string): string => (s.length > perSummary ? s.slice(0, perSummary) : s);
  const body = candidates.map((c, i) => `${lines[i]}${cut(c.summary)}\n`).join('\n');
  return `${head}${cut(subject.summary)}${headTail}${body}`;
}
