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

const day = (value: string | null | undefined): string | null => {
  const us = parseDecidedAt(value);
  return us === null ? null : new Date(Number(us / 1000n)).toISOString().slice(0, 10);
};

/** max(n * 512, 2048), capped at 8192 - the brain's formula (plan Decision 6). */
export function v1MaxTokens(candidateCount: number): number {
  return Math.min(Math.max(candidateCount * 512, 2048), 8192);
}

/**
 * How many characters of each summary the window leaves room for. The summaries share what is left of the window, and
 * a summary shorter than its share gives the unused part back to the longer ones, which are cut instead. An equal split
 * starved a long ADR (its decision sentence is often past the first 2,000 characters) while a three-line diff and short
 * commit messages left most of their share unused. Nothing changes when every summary fits or every one is longer than
 * its share: the share is then the same equal split as before.
 */
export function allowedChars(lengths: readonly number[], share: number): number[] {
  const caps = lengths.map(() => share);
  let pool = 0;
  const open = new Set<number>();
  lengths.forEach((len, i) => {
    if (len < share) { caps[i] = len; pool += share - len; } else open.add(i);
  });
  // Each pass hands the pool to the summaries still cut; one that then fits returns its unused part for the next pass.
  while (pool > 0 && open.size > 0) {
    const each = Math.floor(pool / open.size);
    if (each === 0) break;
    pool = 0;
    for (const i of [...open]) {
      const want = lengths[i]! - caps[i]!;
      if (want <= each) { caps[i] = lengths[i]!; pool += each - want; open.delete(i); } else caps[i]! += each;
    }
  }
  return caps;
}

export interface PromptCuts {
  /** The window the prompt was built for, in tokens. */
  windowTokens: number;
  /** The proposed change, when it was cut: characters kept of characters written. */
  subject: { kept: number; total: number } | null;
  /** One entry per candidate, null when that summary went in whole. */
  candidates: Array<{ kept: number; total: number } | null>;
}

function plan(subject: V1Subject, candidates: readonly V1Candidate[], windowTokens: number, outputTokens: number) {
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
  // Titles and labels are never cut; the summaries share what is left of the window.
  const fixed = estimateTokens(buildV1SystemPrompt()) + outputTokens + estimateTokens(`${head}${headTail}${lines.join('\n\n')}\n`);
  const share = charsForTokens(Math.floor(Math.max(0, windowTokens - fixed) / (candidates.length + 1)));
  const caps = allowedChars([subject.summary.length, ...candidates.map((c) => c.summary.length)], share);
  return { head, headTail, lines, caps };
}

export function buildV1UserPrompt(subject: V1Subject, candidates: readonly V1Candidate[], windowTokens: number, outputTokens: number): string {
  const { head, headTail, lines, caps } = plan(subject, candidates, windowTokens, outputTokens);
  const body = candidates.map((c, i) => `${lines[i]}${c.summary.slice(0, caps[i + 1])}\n`).join('\n');
  return `${head}${subject.summary.slice(0, caps[0])}${headTail}${body}`;
}

/** What buildV1UserPrompt left out of each summary at this window, for the caller to say so. */
export function v1PromptCuts(subject: V1Subject, candidates: readonly V1Candidate[], windowTokens: number, outputTokens: number): PromptCuts {
  const { caps } = plan(subject, candidates, windowTokens, outputTokens);
  const cut = (total: number, i: number) => (total > caps[i]! ? { kept: caps[i]!, total } : null);
  return { windowTokens, subject: cut(subject.summary.length, 0), candidates: candidates.map((c, i) => cut(c.summary.length, i + 1)) };
}
