// ALI-851: the one writer for rendering a decision into text a model reads.
//
// This is the TypeScript twin of align-stack's `services/brain/app/decision_render.py`.
// Two separate repos with no shared filesystem, so the two implementations are pinned to
// agree by a shared fixture committed byte-identical in both:
//   align-stack: services/brain/tests/fixtures/decision_render_fixture.json
//   align-cli:   src/__tests__/fixtures/decision-render-fixture.json
// Each side's test renders its own copy and asserts the recorded `expected` strings, so
// both sides agreeing with one golden is how the two languages are proven to agree with
// each other. Do not change this file's OUTPUT SHAPE without updating both fixture copies
// and re-running both test suites - see decision_render.py's module docstring for the full
// rationale (why the bracket order is what it is, why truncation is estimated rather than
// counted live, why `dimension` is a caller-formatted string rather than a typed import).
//
// INPUT CONTRACT. `d.ordinal` is required (ALI-598: render candidates by ordinal, never a
// raw id - an id present on `d` for the caller's own bookkeeping never reaches the output).
// Everything else is optional. `dimension` is a caller-formatted scope label; this module
// does not import the gateway's DecisionDimension type, so a caller holding one formats it
// before calling (keeps this module dependency-free of the gateway's domain types).
//
// OUTPUT SHAPE, in this exact order (ALI-655: the status flag is FIRST in the bracket - it
// decides which relation types are even worth proposing, so it must not sit behind a long
// line of context a reader skims past):
//
//     {ordinal}. {title} [{STATUS} | {platform} | decided {YYYY-MM-DD} | by {author} |
//     {altitude} | {dimension}]
//        {statement, capped}
//        Rationale: {decision_json.ai.rationale, capped}
//        {cite}
//
// An absent bracket field is omitted with no dangling separator; an empty bracket is
// omitted entirely. `budget: 'compact'` returns the first line alone; `'full'` adds the
// statement, rationale and cite lines.

import { charsForTokens, estimateTokens } from './token-estimate.js';

export type RenderBudget = 'compact' | 'full';

export interface RenderableDecision {
  /** Required. A positive integer the CALLER assigns when numbering a candidate list -
   * never a raw id/uuid (ALI-598). */
  ordinal: number;
  title?: string | null;
  /** One of decision_snapshots.status - 'superseded'/'archived' render RETIRED,
   * 'conflicted' renders CONFLICTED, anything else renders no flag. */
  status?: string | null;
  platform?: string | null;
  /** ISO 8601. */
  decided_at?: string | null;
  author?: string | null;
  architectural_altitude?: string | null;
  /** A caller-formatted scope label, e.g. "infra: max_tokens=4096". */
  dimension?: string | null;
  summary?: string | null;
  decision_json?: { ai?: { rationale?: string | null } | null } | null;
  /** A pre-formatted citation like "align-stack#1742" (format.ts:citationFor) - not
   * re-derived here. */
  cite?: string | null;
  /** Never read for rendering - present only so a caller's row shape does not need
   * stripping before calling. See the ALI-598 positive control in decision-render.test.ts. */
  id?: string;
}

const ELISION = '...';

const RETIRED_STATUSES = new Set(['superseded', 'archived']);
const CONFLICTED_STATUS = 'conflicted';

// Full-budget per-field caps, in ESTIMATED tokens - mirrors decision_render.py's
// FULL_STATEMENT_TOKEN_BUDGET/FULL_RATIONALE_TOKEN_BUDGET exactly. Keep the two in step; a
// drift here silently breaks the cross-language byte-identity the shared fixture pins.
export const FULL_STATEMENT_TOKEN_BUDGET = 90;
export const FULL_RATIONALE_TOKEN_BUDGET = 110;

function capToTokens(text: string, maxTokens: number): string {
  if (!text) return text;
  if (estimateTokens(text) <= maxTokens) return text;
  const limit = Math.max(0, charsForTokens(maxTokens) - ELISION.length);
  return text.slice(0, limit).trimEnd() + ELISION;
}

function statusFlag(status: string | null | undefined): string | null {
  if (!status) return null;
  if (RETIRED_STATUSES.has(status)) return 'RETIRED';
  if (status === CONFLICTED_STATUS) return 'CONFLICTED';
  return null;
}

/** Mirrors app/relationship_type_rules.parse_decided_at's ISO-string branch: an
 * unparseable value is MISSING, not an error, same as the Python side. */
function decidedLabel(decidedAt: string | null | undefined): string | null {
  if (!decidedAt) return null;
  const parsed = new Date(decidedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return `decided ${parsed.toISOString().slice(0, 10)}`;
}

function buildBracket(d: RenderableDecision): string {
  const parts: string[] = [];

  const flag = statusFlag(d.status);
  if (flag) parts.push(flag);

  if (d.platform) parts.push(String(d.platform));

  const decided = decidedLabel(d.decided_at);
  if (decided) parts.push(decided);

  if (d.author && d.author.trim()) parts.push(`by ${d.author.trim()}`);

  if (d.architectural_altitude) parts.push(String(d.architectural_altitude));

  if (d.dimension) parts.push(String(d.dimension));

  return parts.length ? ` [${parts.join(' | ')}]` : '';
}

export function renderDecision(d: RenderableDecision, opts: { budget: RenderBudget }): string {
  if (opts.budget !== 'compact' && opts.budget !== 'full') {
    throw new Error(
      `renderDecision: unknown budget ${JSON.stringify(opts.budget)}, expected 'compact' or 'full'`,
    );
  }

  if (d.ordinal === undefined || d.ordinal === null) {
    // ALI-598: an id must never ride the text - the ordinal is what the caller assigns
    // instead. A missing ordinal is a caller bug, not a "render with no number" case.
    throw new Error("renderDecision: 'ordinal' is required (ALI-598 - never render a raw id)");
  }
  if (!Number.isInteger(d.ordinal) || d.ordinal < 1) {
    throw new Error(`renderDecision: 'ordinal' must be a positive integer, got ${JSON.stringify(d.ordinal)}`);
  }

  const title = d.title ?? '';
  const bracket = buildBracket(d);
  const firstLine = `${d.ordinal}. ${title}${bracket}`;

  if (opts.budget === 'compact') return firstLine;

  const lines = [firstLine];

  if (d.summary) {
    lines.push(`   ${capToTokens(String(d.summary), FULL_STATEMENT_TOKEN_BUDGET)}`);
  }

  const rationale = d.decision_json?.ai?.rationale;
  if (rationale) {
    lines.push(`   Rationale: ${capToTokens(String(rationale), FULL_RATIONALE_TOKEN_BUDGET)}`);
  }

  if (d.cite) {
    lines.push(`   ${d.cite}`);
  }

  return lines.join('\n');
}
