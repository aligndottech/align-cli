/**
 * L9: make every untrusted string safe to print on a terminal a person is about to answer.
 *
 * A decision's title, text, URL and notes come from sources other people write (a PR title, a Slack
 * thread). Raw, they can carry ESC sequences that rewrite or clear the screen, a bare CR that overwrites
 * the line above, or bidi overrides that reorder what is read, so the preview would show something other
 * than what is sent. Each such character is replaced by a visible escape (`\x1b`, `‮`), never
 * dropped: dropping would also hide that it was there.
 *
 * Covered: C0 (including ESC, CR, tab), DEL and C1, line and paragraph separators, zero-width and
 * directional marks, the bidi embedding/override/isolate ranges (U+202A-202E, U+2066-2069) and the BOM.
 * `\n` is kept only when the caller asks (the indented body), because it cannot overwrite earlier text.
 */
// The control characters are the point of this pattern.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export function visible(text: string, opts: { keepNewline?: boolean } = {}): string {
  return text.replace(UNSAFE, (c) => {
    if (c === '\n' && opts.keepNewline) return c;
    const code = c.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
