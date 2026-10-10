import { describe, expect, it } from 'vitest';
import type { DecisionRow } from '../lib/local-db.js';
import { buildSharePayload } from '../lib/share/payload.js';
import { renderPreview } from '../lib/share/preview.js';
import { renderResults, secretRefusal } from '../lib/share/run.js';
import { visible } from '../lib/share/visible.js';

/**
 * L9 security review, item 2: nothing a source author controls can rewrite the terminal.
 * - visible(): ESC, CR, NUL, DEL, C1, U+2028/9, zero-width and directional marks, U+202A-202E and U+2066-2069 become visible
 *   escapes (not dropped); ordinary text, accented letters, emoji and (only on request) \n are untouched.
 * - A preview built from a hostile title, text, URL, note, workspace and email holds no 0x1b, 0x0d or bidi control, shows the escapes,
 *   keeps its newlines, and its LAST line is the destination, directly above the question.
 * - renderResults and secretRefusal sanitise server-supplied ids, reasons and errors the same way.
 */
const ESC = '\u001b'; const CR = '\r'; const RLO = '‮'; const ISO = '⁦';
const BAD = new RegExp(`[\\u001b\\r\\u202a-\\u202e\\u2066-\\u2069]`);

describe('visible, by Unicode category', () => {
  it.each([
    ['a tag character', 'a\u{E0041}b', 'a\\u{e0041}b'],
    ['an Arabic letter mark', 'a\u061cb', 'a\\u061cb'],
    ['a soft hyphen', 'a\u00adb', 'a\\xadb'],
    ['a Mongolian vowel separator', 'a\u180eb', 'a\\u180eb'],
    ['a Hangul filler', 'a\u3164b', 'a\\u3164b'],
    ['a combining grapheme joiner', 'a\u034fb', 'a\\u034fb'],
    ['an interlinear annotation mark', 'a\ufff9b', 'a\\ufff9b'],
    ['a lone surrogate', 'a\ud800b', 'a\\ud800b'],
  ])('escapes %s', (_n, input, expected) => { expect(visible(input)).toBe(expected); });
  it('leaves plain ASCII, accents, CJK and an emoji alone', () => {
    for (const t of ['plain ASCII text - 123', 'Café Zoë', '日本語', '🚀 launch']) expect(visible(t)).toBe(t);
  });
});

describe('visible', () => {
  it('escapes each class by name', () => {
    expect(visible(`a${ESC}[2Jb`)).toBe('a\\x1b[2Jb');
    expect(visible('a\rb')).toBe('a\\x0db');
    expect(visible(`x${RLO}y`)).toBe('x\\u202ey');
    expect(visible(`x${ISO}y`)).toBe('x\\u2066y');
    expect(visible('a\u0085b\u007fc\u0000d e​f')).toBe('a\\x85b\\x7fc\\x00d\\u2028e\\u200bf');
  });
  it('leaves normal text alone, and keeps a newline only when asked', () => {
    expect(visible('Café résumé 日本語 🚀 - ok')).toBe('Café résumé 日本語 🚀 - ok');
    expect(visible('a\nb')).toBe('a\\x0ab');
    expect(visible('a\nb', { keepNewline: true })).toBe('a\nb');
    expect(visible('a\r\nb', { keepNewline: true })).toBe('a\\x0d\nb');
  });
});

const row = (over: Partial<DecisionRow>): DecisionRow => ({
  id: '11111111-1111-4111-8111-111111111111', title: 't', summary: 's', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github',
  createdAt: '2026-09-01T00:00:00.000Z', decidedAt: null, repo: null, deciderKind: 'human', confirmedBy: null, confirmedAt: null, ratifiedBy: 'me', ratifiedAt: '2026-09-03T10:00:00.000Z', ...over,
});

describe('a hostile preview', () => {
  const hostile = `Safe title${ESC}[2J${ESC}[1;1HYou are sharing nothing${CR}`;
  const p = buildSharePayload({
    row: row({ title: hostile, summary: `line one${CR}overwrite\nline two ${RLO}evil`, sourceUrl: `https://x.test/p${ESC}]0;pwn` }),
    judgements: [{ id: 'j', decision_id: '11111111-1111-4111-8111-111111111111', counterpart_id: null, context_key: null, kind: 'note', value: null, note: `n${ESC}[31m`, judge_id: 'i', judge_label: null, via: 'mcp', agent_id: `ag${ESC}`, judged_at: '2026-09-04T10:00:00.000Z' }],
    remoteIdOf: () => undefined, titleOf: () => null, clientKey: 'k', alreadySent: new Set(),
  });
  const text = renderPreview([p], { workspace: `Acme${ESC}[2J`, env: 'prod', email: `me${RLO}@x` });
  it('holds no escape, carriage return or bidi control, and shows the escapes instead', () => {
    expect(text).not.toMatch(BAD);
    expect(text).toContain('\\x1b[2J');
    expect(text).toContain('\\u202e');
    expect(text).toContain('line two');
    expect(text.split('\n').length).toBeGreaterThan(10); // newlines in the body survive
  });
  it('ends with the destination line, the last thing read before the question', () => {
    const lines = text.split('\n');
    expect(lines[lines.length - 1]).toMatch(/^To: Acme\\x1b\[2J \(prod\) as me\\u202e@x$/);
    expect(lines[lines.length - 2]).toBe('Nothing is sent until you say yes.');
  });
  it('results and refusals are sanitised too', () => {
    const r = renderResults([{ localId: 'a', title: `T${ESC}x`, outcome: { kind: 'refused', index: 0, reason: `r${CR}x` }, judgementFailures: [{ index: 0, error: `e${ESC}` }], warnings: [`w${ESC}[2J`] }]);
    expect(r).not.toMatch(BAD);
    expect(secretRefusal([{ localId: `id${ESC}`, field: 'title', placeholder: '<GITHUB_TOKEN>' }])).not.toMatch(BAD);
  });
});
