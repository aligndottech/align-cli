import { describe, expect, it } from 'vitest';
import { conflictSeverity } from '../lib/conflict-severity.js';
import { judgeAgainstDecisionsFile } from '../lib/decisions-file-check.js';

/*
 * A model-judged conflict is CRITICAL only when its confidence is >= 0.8 AND it is grounded in text a program can
 * check: (a) v1: both evidence quotes are present in the decision and the change, or (b) any detector: a distinctive
 * literal from the changed lines also appears in the decision. Otherwise it is a WARNING. It stays a conflict either
 * way; only the label (and the opt-in --block-on-critical deny) changes. Before this, `confidence >= 0.8` alone made
 * CRITICAL: a model saying "likely relates to ... potentially undermining" at 0.9 was CRITICAL (reported on the 365 -> 3650 edit).
 *
 * Pairs: what now downgrades / what still blocks. "Old" is what `confidence >= 0.8` did with the same input.
 *  1. hedged verdict on a decision sharing no literal        -> warning  (old: critical)   | 365 commit on 365->3650 -> critical (old: critical)
 *  2. v1 verdict whose quotes are not in the texts           -> warning  (old: critical)   | v1 verdict with real quotes -> critical (old: critical)
 *  3. grounded but confidence 0.79                           -> warning  (old: warning)    | grounded at 0.8 -> critical
 *  4. added-only change vs a "no Redis" decision, grounded   -> critical (old: critical)   | added-only change sharing nothing -> warning (old: critical)
 */
const CHANGE = ['diff --git a/scripts/check_ledger.py b/scripts/check_ledger.py', '--- a/scripts/check_ledger.py', '+++ b/scripts/check_ledger.py', '@@ -40,3 +40,3 @@', ' import sys', '-MAX_REVIEW_DAYS = 365', '+MAX_REVIEW_DAYS = 3650', ' def main():', ''].join('\n');
const COMMIT_365 = "check_ledger: bound review_by to its modified date\n\n- An active control's review_by must fall on or after its modified date and no more than 365 days after it.";
const UNRELATED = 'Release notes are written by the on-call engineer and posted to the team channel every Friday.';

describe('conflictSeverity', () => {
  it('downgrades a 0.9 verdict on a decision that shares no literal with the change', () => {
    expect(conflictSeverity(0.9, { decisionText: UNRELATED, changeText: CHANGE })).toBe('warning');
  });
  it('still blocks the commit that set 365 when the edit raises it to 3650', () => {
    expect(conflictSeverity(0.9, { decisionText: COMMIT_365, changeText: CHANGE })).toBe('critical');
  });

  it('downgrades a v1 verdict whose quotes are not in the decision and the change', () => {
    const evidence = { new_quote: 'drops the review window entirely', existing_quote: 'reviews must happen quarterly' };
    expect(conflictSeverity(0.9, { decisionText: UNRELATED, changeText: CHANGE, evidence })).toBe('warning');
  });
  it('still blocks a v1 verdict whose quotes are real, whitespace and case aside', () => {
    const evidence = { new_quote: 'MAX_REVIEW_DAYS  =\n 3650', existing_quote: 'posted to the team channel every Friday' };
    const change = '@@ -1 +1 @@\n+// posted weekly';
    expect(conflictSeverity(0.9, { decisionText: UNRELATED, changeText: `${CHANGE}\n${change}`, evidence })).toBe('critical');
  });
  it('needs both quotes: one real and one invented is not grounding', () => {
    const evidence = { new_quote: 'MAX_REVIEW_DAYS = 3650', existing_quote: 'reviews must happen quarterly' };
    expect(conflictSeverity(0.9, { decisionText: UNRELATED, changeText: CHANGE, evidence })).toBe('warning');
  });

  it('keeps a grounded verdict below 0.8 a warning, and 0.8 itself critical', () => {
    expect(conflictSeverity(0.79, { decisionText: COMMIT_365, changeText: CHANGE })).toBe('warning');
    expect(conflictSeverity(0.8, { decisionText: COMMIT_365, changeText: CHANGE })).toBe('critical');
  });

  it('lets an added-only change be critical when it shares a name with the decision', () => {
    const change = 'diff --git a/cache.ts b/cache.ts\n--- a/cache.ts\n+++ b/cache.ts\n@@ -1,1 +1,2 @@\n import x from "y";\n+const c = connect(process.env.REDIS_URL);\n';
    expect(conflictSeverity(0.9, { decisionText: 'Staging only reads REDIS_URL.', changeText: change })).toBe('critical');
  });
  it('lets an added-only change be critical when it shares two plain words with the decision', () => {
    const change = 'diff --git a/cache.ts b/cache.ts\n--- a/cache.ts\n+++ b/cache.ts\n@@ -1,1 +1,2 @@\n import x from "y";\n+const cache = new Redis(process.env.REDIS_URL);\n';
    expect(conflictSeverity(0.9, { decisionText: 'No Redis. Keep the cache in-process.', changeText: change })).toBe('critical');
  });
  it('downgrades an added-only change that shares nothing with the decision', () => {
    const change = 'diff --git a/cache.ts b/cache.ts\n--- a/cache.ts\n+++ b/cache.ts\n@@ -1,1 +1,2 @@\n import x from "y";\n+const cache = new Redis(process.env.REDIS_URL);\n';
    expect(conflictSeverity(0.9, { decisionText: UNRELATED, changeText: change })).toBe('warning');
  });

  it('does not ground on a short quote, a quote of a header, a JSON/HTTP word, or a date', () => {
    expect(conflictSeverity(0.9, { decisionText: UNRELATED, changeText: CHANGE, evidence: { new_quote: 'is', existing_quote: 'the' } })).toBe('warning');
    expect(conflictSeverity(0.9, { decisionText: UNRELATED, changeText: CHANGE, evidence: { new_quote: 'scripts/check_ledger.py', existing_quote: 'posted to the team channel' } })).toBe('warning');
    expect(conflictSeverity(0.9, { decisionText: 'We send JSON over HTTP on 2026-11-25.', changeText: '@@ -1 +1 @@\n+// JSON over HTTP, 2026-11-25' })).toBe('warning');
  });
  it('treats text that is not a diff as its own changed text', () => {
    expect(conflictSeverity(0.9, { decisionText: COMMIT_365, changeText: 'raise MAX_REVIEW_DAYS to 3650 and 365' })).toBe('critical');
  });

  // Not a pass for a guess: a single shared plain word ("review") is not enough, a lone number is, and a stop word never is.
  it('does not ground on one shared plain word, or on a common word', () => {
    expect(conflictSeverity(0.9, { decisionText: 'Every review needs two people.', changeText: CHANGE.replace('MAX_REVIEW_DAYS', 'review') })).toBe('warning');
    expect(conflictSeverity(0.9, { decisionText: 'We default to the main branch.', changeText: '@@ -1 +1 @@\n-default\n+other' })).toBe('warning');
  });
  // KNOWN LIMIT, shown rather than hidden: two shared plain words ground a guess. Added lines make this possible.
  it('known limit: a guess sharing two plain words with the change stays critical', () => {
    const change = '@@ -1 +1 @@\n+sendInvoices(customers, schedule)';
    expect(conflictSeverity(0.9, { decisionText: 'Invoices go to customers by email.', changeText: change })).toBe('critical');
  });
});

describe('judgeAgainstDecisionsFile uses the same rule', () => {
  const run = (confidence: number, why: string, evidence?: { new_quote: string; existing_quote: string }) =>
    judgeAgainstDecisionsFile(CHANGE, [{ title: 'A rule', why }], { file: 'DECISIONS.md' }, {
      classify: async () => ({ version: 'v1', outcomes: [{ ok: true, relationship: { type: 'conflicts_with', confidence, reason: 'likely relates to the audit findings, potentially undermining them', ...(evidence ? { evidence } : {}) } }] }),
    });
  it('a hedged 0.9 conflict on an ungrounded rule is a warning, and still a conflict', async () => {
    const r = await run(0.9, UNRELATED);
    expect(r.status).toBe('conflicting');
    expect(r.conflicts[0]!.severity).toBe('warning');
  });
  it('the same verdict on a rule naming 365 days is critical', async () => {
    expect((await run(0.9, 'Reviews are due within 365 days.')).conflicts[0]!.severity).toBe('critical');
  });
});

