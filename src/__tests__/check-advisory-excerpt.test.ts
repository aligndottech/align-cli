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

  describe('a commit-shaped summary', () => {
    const url = 'https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567';
    const subject = 'Keep all app state in src/store.ts';
    const body = 'Module-level state in services caused stale carts after logout, so every piece of state now goes through the store.';
    const commit = (extra = ''): string => `${subject}\n\n${body}\n\nAuthor: Dev\n\nDate: 2026-01-02T03:04:05Z${extra}`;

    it('drops the copy of the title at the start and the commit metadata after the body', () => {
      const out = ctx(buildRelatedOutput([], claude, [{ id: 'w', title: subject, url, summary: commit() }]));
      expect(out).toContain(`- ${subject}\n  ${body}\n`);
      expect(out).not.toContain('Author:');
      expect(out).not.toContain('Date:');
    });

    it('matches the title after whitespace normalisation', () => {
      const out = ctx(buildRelatedOutput([], claude, [{ id: 'w', title: subject, url, summary: `Keep  all app\nstate in src/store.ts\n\n${body}` }]));
      expect(out).toContain(`- ${subject}\n  ${body}\n`);
    });

    it('strips Co-Authored-By and Signed-off-by trailers and the files list', () => {
      const out = ctx(buildRelatedOutput([], claude, [{ id: 'w', title: subject, url, summary: `${subject}\n\n${body}\n\nSigned-off-by: A <a@x>\nCo-Authored-By: B <b@x>\n\nAuthor: Dev\n\nDate: d\n\nFiles changed:\nsrc/store.ts` }]));
      expect(out).toContain(`- ${subject}\n  ${body}\n`);
      expect(out).not.toMatch(/Signed-off-by|Co-Authored-By|Files changed|Author:/);
    });

    it('keeps the title alone when only the title and metadata are left', () => {
      const out = ctx(buildRelatedOutput([], claude, [{ id: 'w', title: subject, url, summary: `${subject}\n\nAuthor: Dev\n\nDate: d` }]));
      expect(out).toContain(`- ${subject}\nCheck that`);
    });

    it('keeps a summary that merely starts with the title words but goes on', () => {
      const out = ctx(buildRelatedOutput([{ id: 'a', title: 'Architecture', summary: 'Architecture of the store: one module owns state.' }], claude));
      expect(out).toContain('- Architecture\n  Architecture of the store: one module owns state.');
    });
  });

  describe('what reaches the agent is safe to show', () => {
    const GITHUB_PAT = `ghp_${'x'.repeat(36)}`;
    const AWS_KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`;
    const shown = (summary: string, url?: string): string => ctx(buildRelatedOutput([{ id: 's', title: 'Secrets', summary, ...(url ? { url } : {}) }], claude));
    const excerptLine = (out: string): string => out.split('\n')[2] as string;

    it('redacts a GitHub token and an AWS key before they reach the output', () => {
      const out = shown(`Deploy uses ${GITHUB_PAT} and ${AWS_KEY} for the bucket.`);
      expect(out).not.toContain(GITHUB_PAT);
      expect(out).not.toContain(AWS_KEY);
      expect(excerptLine(out)).toMatch(/^ {2}Deploy uses .* for the bucket\.$/);
    });

    it('redacts before truncating: the short placeholder leaves room for the text after the secret', () => {
      const out = shown(`${'a'.repeat(150)} ${GITHUB_PAT} the end`);
      expect(out).not.toContain('ghp_');
      expect(excerptLine(out)).toMatch(/ the end$/);
    });

    it('strips control characters such as an ESC sequence', () => {
      const out = shown('red \u001b[31mALERT\u001b[0m ok\u0007 done\u007f');
      expect(excerptLine(out)).toBe('  red [31mALERT[0m ok done');
    });

    it('never splits a surrogate pair at the cut', () => {
      const out = shown(`${'x'.repeat(EXCERPT_BUDGET_CHARS - 4)}\u{1F600}\u{1F600} tail`);
      const line = excerptLine(out).trim();
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(line)).toBe(false);
      expect(Array.from(line).length).toBeLessThanOrEqual(EXCERPT_BUDGET_CHARS);
      expect(line.endsWith('...')).toBe(true);
    });

    it('strips commit metadata only for a decision that came from a commit', () => {
      const text = 'Keep state in the store\n\nWhy: stale carts.\n\nAuthor: Dev\n\nDate: 2026-01-02';
      const fromCommit = shown(text, 'https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567');
      expect(fromCommit).not.toContain('Author:');
      expect(fromCommit).toContain('Why: stale carts.');
    });

    it('a doc decision keeps its Author and Date lines', () => {
      const out = shown('Release notes\nDate: weekly\nShip on Tuesdays.', 'https://github.com/acme/app/blob/main/CLAUDE.md');
      expect(excerptLine(out)).toBe('  Release notes Date: weekly Ship on Tuesdays.');
    });
  });

  describe('titles are as safe as excerpts', () => {
    const GITHUB_PAT = `ghp_${'y'.repeat(36)}`;
    it('redacts a secret and strips controls in a decision title', () => {
      const out = ctx(buildRelatedOutput([{ id: 't', title: `Use ${GITHUB_PAT} \u001b[31mnow`, summary: 'Short body text that is long enough to show.' }], claude));
      expect(out).not.toContain(GITHUB_PAT);
      expect(out).not.toContain('\u001b');
    });
    it('redacts a secret in the successor title', () => {
      const out = ctx(buildRelatedOutput([{ id: 'o', title: 'Old', status: 'superseded', successor: { id: 'n', title: `Rotate ${GITHUB_PAT}` } }], claude));
      expect(out).not.toContain(GITHUB_PAT);
      expect(out).toContain('(replaced by: Rotate ');
    });
  });

  describe('a replaced decision says so', () => {
    it('shows the marker and the successor on the title line', () => {
      const out = ctx(buildRelatedOutput([{ id: 'o', title: 'Use Redux', summary: 'State lives in Redux.', status: 'superseded', successor: { id: 'n', title: 'Use the store module' } }], claude));
      expect(out).toContain('- Use Redux (replaced by: Use the store module)\n  State lives in Redux.');
    });

    it('says only "replaced" when the successor is unknown', () => {
      const out = ctx(buildRelatedOutput([{ id: 'o', title: 'Use Redux', status: 'superseded' }], claude));
      expect(out).toContain('- Use Redux (replaced)\n');
    });

    it('an active decision carries no marker', () => {
      const out = ctx(buildRelatedOutput([{ id: 'a', title: 'Use the store module', summary: 'One module owns state.' }], claude));
      expect(out).not.toContain('replaced');
    });

    it('applies to a blame decision too', () => {
      const out = ctx(buildRelatedOutput([], claude, [{ id: 'o', title: 'Use Redux', status: 'superseded', successor: { id: 'n', title: 'Use the store module' } }]));
      expect(out).toContain('- Use Redux (replaced by: Use the store module)');
    });
  });
});
