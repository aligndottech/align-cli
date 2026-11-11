import { describe, expect, it } from 'vitest';
import { buildRelatedOutput, EXCERPT_BUDGET_CHARS, EXCERPT_TOTAL_BUDGET_CHARS } from '../commands/check.js';

/**
 * The advisory hook lists decisions by title. A section imported from CLAUDE.md is titled by its
 * heading ("Architecture"), so the title alone does not say what the rule is. Each listed decision
 * carries a short excerpt of its text, bounded per decision and in total.
 */
const claude = { pre: true, format: 'claude', blockOnCritical: false } as const;
const ctx = (out: unknown): string => (out as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('advisory output carries what each decision says', () => {
  it('a CLAUDE.md section shows its rule text under the heading title', () => {
    const out = ctx(buildRelatedOutput([{ id: 'c1', title: 'Architecture', summary: 'Keep all app state in src/store.ts. Never use module-level singletons.' }], claude));
    expect(out).toContain('- Architecture\n  Keep all app state in src/store.ts. Never use module-level singletons.');
  });

  it('a second CLAUDE.md section shows its own text', () => {
    const out = ctx(buildRelatedOutput([{ id: 'c2', title: 'Testing', summary: 'Write the test first.' }], claude));
    expect(out).toContain('- Testing\n  Write the test first.');
  });

  it('a git-blame decision shows its text', () => {
    const out = ctx(buildRelatedOutput([], claude, [{ id: 'w1', title: 'Cache sessions in Redis', summary: 'Sessions move to Redis so pods stay stateless.' }]));
    expect(out).toContain('- Cache sessions in Redis\n  Sessions move to Redis so pods stay stateless.');
  });

  it('truncates a long summary to the budget at a word boundary with an ellipsis', () => {
    const out = ctx(buildRelatedOutput([{ id: 'l1', title: 'Long', summary: words(80) }], claude));
    const excerpt = out.split('\n').find((l) => l.startsWith('  word')) as string;
    const body = excerpt.trim();
    expect(body.length).toBeLessThanOrEqual(EXCERPT_BUDGET_CHARS);
    expect(body.endsWith('...')).toBe(true);
    // cut on a word boundary: the last word before the ellipsis is a whole word
    expect(body.slice(0, -3)).toMatch(/word\d+$/);
    expect(words(80).startsWith(body.slice(0, -3))).toBe(true);
    expect(words(80).charAt(body.length - 3)).toBe(' ');
  });

  it('keeps a summary at exactly the budget whole', () => {
    const exact = 'x'.repeat(EXCERPT_BUDGET_CHARS);
    const out = ctx(buildRelatedOutput([{ id: 'e1', title: 'Exact', summary: exact }], claude));
    expect(out).toContain(`  ${exact}\n`);
  });

  it('a decision with no text keeps the title alone', () => {
    const none = ctx(buildRelatedOutput([{ id: 'n1', title: 'Bare title' }], claude));
    const blank = ctx(buildRelatedOutput([{ id: 'n2', title: 'Blank title', summary: '   \n ' }], claude));
    expect(none).toContain('- Bare title\nThese are related');
    expect(blank).toContain('- Blank title\nThese are related');
  });

  it('collapses newlines in a multi-line summary onto one indented line', () => {
    const out = ctx(buildRelatedOutput([{ id: 'm1', title: 'Multi', summary: 'line one\n\nline two' }], claude));
    expect(out).toContain('- Multi\n  line one line two\n');
  });

  it('caps the total excerpt text: later decisions fall back to the title alone', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, title: `Decision ${i}`, summary: words(80) }));
    const out = ctx(buildRelatedOutput(many, claude));
    const excerptChars = out.split('\n').filter((l) => l.startsWith('  word')).reduce((n, l) => n + l.trim().length, 0);
    expect(excerptChars).toBeLessThanOrEqual(EXCERPT_TOTAL_BUDGET_CHARS);
    expect(out).toContain('- Decision 0\n  word0');
    expect(out).toContain('- Decision 11\nThese are related');
  });

  it('the cap is shared between blame and content decisions', () => {
    const wrote = Array.from({ length: 5 }, (_, i) => ({ id: `w${i}`, title: `Writer ${i}`, summary: words(80) }));
    const out = ctx(buildRelatedOutput([{ id: 'r', title: 'Related', summary: words(80) }], claude, wrote));
    const excerptChars = out.split('\n').filter((l) => l.startsWith('  word')).reduce((n, l) => n + l.trim().length, 0);
    expect(excerptChars).toBeLessThanOrEqual(EXCERPT_TOTAL_BUDGET_CHARS);
  });

  it('a non-claude host (codex) carries the excerpt too', () => {
    const out = ctx(buildRelatedOutput([{ id: 'c1', title: 'Architecture', summary: 'Keep all app state in src/store.ts.' }], { pre: true, format: 'codex', blockOnCritical: false }));
    expect(out).toContain('- Architecture\n  Keep all app state in src/store.ts.');
  });

  it('cursor post carries the excerpt in additional_context', () => {
    const out = buildRelatedOutput([{ id: 'c1', title: 'Architecture', summary: 'Keep all app state in src/store.ts.' }], { pre: false, format: 'cursor', blockOnCritical: false }) as { additional_context: string };
    expect(out.additional_context).toContain('- Architecture\n  Keep all app state in src/store.ts.');
  });
});
