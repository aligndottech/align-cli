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

  // Three ways the grounding read more, or less, than the change says. Each has the case that must still hold.
  it('does not take a quote that drops the underscore from a name as a quote of the change', () => {
    const change = '@@ -1 +1,2 @@\n import x from "y";\n+const url = process.env.REDIS_URL;';
    const evidence = { new_quote: 'REDISURL', existing_quote: 'Keep PostgreSQL for persistence' };
    expect(conflictSeverity(0.9, { decisionText: 'Keep PostgreSQL for persistence.', changeText: change, evidence })).toBe('warning');
  });
  it('still reads a quote through the markdown emphasis in a decision', () => {
    const change = '@@ -1 +1,2 @@\n import x from "y";\n+const c = connect(process.env.CACHE_HOST);';
    const evidence = { new_quote: 'connect(process.env.CACHE_HOST)', existing_quote: 'only reads REDIS_URL, and never writes it' };
    expect(conflictSeverity(0.9, { decisionText: 'Staging **only** reads `REDIS_URL`, and _never_ writes it.', changeText: change, evidence })).toBe('critical');
  });

  const twoFiles = (secondName: string, secondOld: string, secondNew: string): string =>
    ['--- a/one.ts', '+++ b/one.ts', '@@ -1 +1 @@', '-const a = 1;', '+const a = 2;',
      `--- a/${secondName}`, `+++ b/${secondName}`, '@@ -1 +1 @@', `-${secondOld}`, `+${secondNew}`].join('\n');
  const KEEP_365 = 'MAX_REVIEW_DAYS stays at 365.';
  it('does not ground on the name of a second file in a patch that has no "diff --git" lines', () => {
    expect(conflictSeverity(0.9, { decisionText: KEEP_365, changeText: twoFiles('MAX_REVIEW_DAYS.md', 'hello there', 'goodbye now') })).toBe('warning');
  });
  it('still reads the changed lines of that second file', () => {
    expect(conflictSeverity(0.9, { decisionText: KEEP_365, changeText: twoFiles('notes.md', 'MAX_REVIEW_DAYS = 365', 'MAX_REVIEW_DAYS = 3650') })).toBe('critical');
  });
  // A removed "-- x" line shows as "--- x" and an added "++ y" line as "+++ y". They are file names only before a hunk header.
  it.each([
    ['no "+++ " line follows it', '@@ -1,2 +1 @@\n--- keep MAX_REVIEW_DAYS at 365\n select 1;'],
    ['a "+++ " line follows it, and no hunk header', '@@ -1 +1 @@\n--- keep MAX_REVIEW_DAYS at 365\n+++ other'],
  ])('still reads a removed line that starts with "-- " when %s', (_name, change) => {
    expect(conflictSeverity(0.9, { decisionText: KEEP_365, changeText: change })).toBe('critical');
  });

  it('counts a negative number as a shared literal', () => {
    const change = '@@ -1 +1 @@\n-const limit = -100;\n+const limit = -200;';
    expect(conflictSeverity(0.9, { decisionText: 'Reject balances below -100.', changeText: change })).toBe('critical');
  });
  // One shape per place a minus sign can stand: after a space, at the start of a line, right after an opener.
  it.each(['const limit = -250;', '  -250,', 'clamp(-250)'])('reads the sign in %j', (line) => {
    expect(conflictSeverity(0.9, { decisionText: 'Never go under -250.', changeText: `@@ -1 +1 @@\n+${line}` })).toBe('critical');
  });
  // A dash after a number, after a closing bracket or after another dash is not a sign, and 20 is then a piece of something.
  it.each(['span = 10 -20', 'span = (10)-20', 'span = {} -20', 'flag --20'])('does not read a sign in %j', (line) => {
    expect(conflictSeverity(0.9, { decisionText: 'Keep 20 workers.', changeText: `@@ -1 +1 @@\n+${line}` })).toBe('warning');
  });

  // A trailing comment that reads the same on the removed line and on the added one was not changed by the edit: the
  // edit changed the code in front of it. Its plain words ground nothing. Reported on a one-line edit of a default
  // from "warn" to "off": three commits that only shared words with the comment on that line were CRITICAL.
  // Pairs: the text that shares words with the comment only (downgrades) / the decision about the code (still blocks).
  const edit = (file: string, before: string, after: string): string =>
    [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -105,1 +105,1 @@', `-${before}`, `+${after}`, ''].join('\n');
  const HASH_NOTE = '   # warn | block | off  (start warn; promote to block once tuned)';
  const HASH_EDIT = edit('hooks/gate.py', `DEFAULT_MODE = "warn"${HASH_NOTE}`, `DEFAULT_MODE = "off"${HASH_NOTE}`);
  const SLASH_NOTE = ' // the gateway retries once, then fails over to the standby region';
  const SLASH_EDIT = edit('src/client.ts', `  retryLimit: 3,${SLASH_NOTE}`, `  retryLimit: 5,${SLASH_NOTE}`);

  it('does not ground on the words of a trailing # comment the edit left as it was', () => {
    // shares start, once and block with the comment, and nothing with DEFAULT_MODE = "warn"
    expect(conflictSeverity(0.9, { decisionText: 'gate: start the session log once per turn, and block a second writer.', changeText: HASH_EDIT })).toBe('warning');
  });
  it('still grounds on the code in front of that # comment', () => {
    expect(conflictSeverity(0.9, { decisionText: 'Default to warn. Promote the gate to block mode only when it is tuned.', changeText: HASH_EDIT.replaceAll(HASH_NOTE, '') })).toBe('critical');
    expect(conflictSeverity(0.9, { decisionText: 'Default to warn. Promote the gate to block mode only when it is tuned.', changeText: HASH_EDIT })).toBe('critical');
  });
  it('does not ground on the words of a trailing // comment the edit left as it was', () => {
    expect(conflictSeverity(0.9, { decisionText: 'The standby region takes traffic when the gateway fails.', changeText: SLASH_EDIT })).toBe('warning');
  });
  it('still grounds on the code in front of that // comment', () => {
    expect(conflictSeverity(0.9, { decisionText: 'The retry limit is three.', changeText: SLASH_EDIT })).toBe('critical');
  });
  it('still grounds on a comment the edit wrote, changed or removed', () => {
    const decisionText = 'The billing ledger lands before the gate is switched back.';
    const changed = edit('hooks/gate.py', 'DEFAULT_MODE = "warn"   # start in warn', 'DEFAULT_MODE = "off"   # switched off until the billing ledger lands');
    expect(conflictSeverity(0.9, { decisionText, changeText: changed })).toBe('critical');
    const removed = edit('hooks/gate.py', 'DEFAULT_MODE = "warn"   # switched off until the billing ledger lands', 'DEFAULT_MODE = "off"');
    expect(conflictSeverity(0.9, { decisionText, changeText: removed })).toBe('critical');
  });
  // The same comment on two lines. "Left as it was" is counted per copy: a copy the edit deleted is part of the change
  // even when another copy of the same words survives on the line below.
  it('still grounds on a comment the edit deleted from one line while a copy of it stays on another', () => {
    const note = '  # keep sessions in the redis cache';
    const change = ['diff --git a/conf.py b/conf.py', '--- a/conf.py', '+++ b/conf.py', '@@ -1,2 +1,2 @@', `-a = 1${note}`, `-b = 2${note}`, '+a = 1', `+b = 3${note}`, ''].join('\n');
    expect(conflictSeverity(0.9, { decisionText: 'Sessions live in the redis cache.', changeText: change })).toBe('critical');
  });
  it('does not ground on a comment that every edited line kept, however many lines carry it', () => {
    const note = '  # keep sessions in the redis cache';
    const change = ['diff --git a/conf.py b/conf.py', '--- a/conf.py', '+++ b/conf.py', '@@ -1,2 +1,2 @@', `-a = 1${note}`, `-b = 2${note}`, `+a = 5${note}`, `+b = 3${note}`, ''].join('\n');
    expect(conflictSeverity(0.9, { decisionText: 'Sessions live in the redis cache.', changeText: change })).toBe('warning');
  });
  it('still grounds on a name inside an unchanged comment: only its plain words are set aside', () => {
    const change = edit('scripts/check.py', 'LIMIT = 3  # see MAX_REVIEW_DAYS', 'LIMIT = 5  # see MAX_REVIEW_DAYS');
    expect(conflictSeverity(0.9, { decisionText: 'MAX_REVIEW_DAYS bounds every review.', changeText: change })).toBe('critical');
  });
  // Two things that look like a comment marker and are not. Both lines keep their tail, so both still ground.
  it('does not read "C# " in prose as the start of a comment: a marker needs a space in front of it', () => {
    const change = edit('docs/export.md', 'The old exporter is written in C# for the billing invoices team.', 'The new exporter is written in C# for the billing invoices team.');
    expect(conflictSeverity(0.9, { decisionText: 'Billing invoices are sent out nightly.', changeText: change })).toBe('critical');
  });
  it('does not read "#1234" as the start of a comment: a marker needs a space after it', () => {
    const change = edit('docs/gaps.md', 'The old gap is tracked in #1234 billing invoices.', 'The new gap is tracked in #1234 billing invoices.');
    expect(conflictSeverity(0.9, { decisionText: 'Billing invoices are sent out nightly.', changeText: change })).toBe('critical');
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

