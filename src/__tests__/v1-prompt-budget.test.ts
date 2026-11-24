/**
 * #719: a local judge ruled "aligned" on a change against an ADR it had retrieved. One cause that is ours: the v1 prompt
 * cut every summary to the same share of the window, so a long ADR lost the paragraph that states its rule while the
 * proposed change and the short commit messages left most of their share unused, and nothing said anything was cut.
 *
 * Test List:
 * 1. a long decision keeps its late rule sentence when the others are short (two windows)
 * 2. nothing is cut when everything fits, and the text is whole
 * 3. when every summary is longer than its share, the split is still equal
 * 4. the prompt never grows past the window it was built for
 * 5. v1PromptCuts says what was left out: nothing at a wide window, the change and the decisions at a narrow one
 */
import { describe, expect, it } from 'vitest';
import { allowedChars, buildV1SystemPrompt, buildV1UserPrompt, v1MaxTokens, v1PromptCuts } from '../detector/relationship-prompt.js';
import { estimateTokens } from '../lib/token-estimate.js';

const filler = (n: number, tag: string): string => Array.from({ length: Math.ceil(n / 12) }, (_, i) => `${tag}${i} word.`).join(' ').slice(0, n);
const RULE = 'RULE: printf is removed.';
const subject = { title: 'Proposed change', summary: filler(300, 'diff'), decidedAt: null, platform: 'cli' };
const short = (i: number) => ({ title: `Commit ${i}`, summary: filler(400, `c${i}x`), similarity: 0.6, platform: 'git', decidedAt: '2026-01-01T00:00:00Z' });
const adr = { title: 'ADR 22', summary: `${filler(2700, 'ctx')} ${RULE} ${filler(1300, 'tail')}`, similarity: 0.7, platform: 'docs', decidedAt: '2026-01-01T00:00:00Z' };
const five = [short(1), adr, short(2), short(3), short(4)];
const OUT = v1MaxTokens(5);

describe('buildV1UserPrompt: the window is shared by need', () => {
  it.each([7000, 8000])('a long decision keeps its late rule sentence at a %i-token window when the others are short', (w) => {
    expect(buildV1UserPrompt(subject, five, w, OUT)).toContain(RULE);
  });

  it('cuts nothing when everything fits: every summary is whole', () => {
    const u = buildV1UserPrompt(subject, five, 32_768, OUT);
    for (const s of [subject.summary, ...five.map((c) => c.summary)]) expect(u).toContain(s);
  });

  it('is an equal split when every summary is longer than its share', () => {
    const big = (i: number, ch: string) => ({ ...short(i), summary: ch.repeat(6000) });
    const u = buildV1UserPrompt({ ...subject, summary: '§'.repeat(6000) }, [big(1, '¶'), big(2, '¤')], 4_500, 1024);
    const count = (ch: string) => u.split(ch).length - 1;
    expect(count('§')).toBeGreaterThan(0);
    expect(count('§')).toBeLessThan(6000);
    expect([count('¶'), count('¤')]).toEqual([count('§'), count('§')]);
  });

  it.each([5000, 7000, 12_000])('stays inside a %i-token window', (w) => {
    const u = buildV1UserPrompt(subject, five, w, OUT);
    expect(estimateTokens(buildV1SystemPrompt()) + OUT + estimateTokens(u)).toBeLessThanOrEqual(w);
  });
});

describe('v1PromptCuts', () => {
  it('reports nothing cut at a wide window', () => {
    expect(v1PromptCuts(subject, five, 32_768, OUT)).toEqual({ windowTokens: 32_768, subject: null, candidates: [null, null, null, null, null] });
  });

  it('reports the change and the decision that were cut at a narrow window, with characters kept of written', () => {
    const cuts = v1PromptCuts(subject, five, 4_096, OUT);
    expect(cuts.windowTokens).toBe(4_096);
    expect(cuts.subject).toEqual({ kept: 0, total: subject.summary.length });
    expect(cuts.candidates[1]).toEqual({ kept: 0, total: adr.summary.length });
  });

  it('reports only the decision that is still cut at a middling window', () => {
    const cuts = v1PromptCuts(subject, five, 6_000, OUT);
    expect(cuts.subject).toBeNull();
    expect(cuts.candidates[0]).toBeNull();
    expect(cuts.candidates[1]!.total).toBe(adr.summary.length);
    expect(cuts.candidates[1]!.kept).toBeGreaterThan(0);
    expect(cuts.candidates[1]!.kept).toBeLessThan(adr.summary.length);
  });
});

describe('allowedChars: a summary exactly as long as its share', () => {
  it('is kept whole and neither borrows from nor gives to the others', () => {
    expect(allowedChars([5, 10, 10], 5)).toEqual([5, 5, 5]);
    expect(allowedChars([5, 5], 5)).toEqual([5, 5]);
  });
  it('one char over its share is cut, and one char under gives the spare char back', () => {
    expect(allowedChars([6, 6], 5)).toEqual([5, 5]);
    expect(allowedChars([4, 20], 5)).toEqual([4, 6]);
  });
});
