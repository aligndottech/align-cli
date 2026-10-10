/**
 * L9: make every untrusted string safe to print on a terminal a person is about to answer.
 *
 * A decision's title, text, URL and notes come from sources other people write (a PR title, a Slack
 * thread). Raw, they can carry ESC sequences that rewrite or clear the screen, a bare CR that overwrites
 * the line above, or bidi overrides that reorder what is read, so the preview would show something other
 * than what is sent. Each such character is replaced by a visible escape (`\x1b`, `‮`), never
 * dropped: dropping would also hide that it was there.
 *
 * Covered, by Unicode category: controls (ESC, CR, tab, NUL, DEL, C1), every format character (bidi
 * overrides and isolates, zero-width, soft hyphen, U+061C, the tag characters U+E0000-E007F), line and
 * paragraph separators, default-ignorable code points (U+034F, U+180E, U+3164, U+FFF9-FFFB) and lone surrogates.
 * `\n` is kept only when the caller asks (the indented body), because it cannot overwrite earlier text.
 */
// Unicode categories rather than hand-listed ranges (a hand-written list is guessing at published data):
// Cc controls (ESC, CR, NUL, C1), Cf format (bidi marks and overrides, zero-width, soft hyphen, ALM, tag
// characters U+E0000-E007F), Zl/Zp line and paragraph separators, Default_Ignorable_Code_Point (Hangul
// fillers, U+034F, U+180E, interlinear annotation marks) and Cs, a lone surrogate (needs the u flag).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]|\p{Cs}/gu;

export function visible(text: string, opts: { keepNewline?: boolean } = {}): string {
  return text.replace(UNSAFE, (c) => {
    if (c === '\n' && opts.keepNewline) return c;
    const code = c.codePointAt(0)!;
    if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`;
    return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`;
  });
}
