/**
 * LM: text from the graph or from a mark reaches a terminal and an agent's context. A decision
 * title comes from a Slack message or a PR, and a note comes from whoever wrote it, so neither is
 * printed raw: a control byte can move the cursor, hide a word (ESC [8m) or forge a whole row, and
 * an invisible format character (a Unicode tag, a zero-width space, a direction mark) can carry
 * text nobody sees.
 *
 * "Unsafe" is every control (Cc), format (Cf), private-use (Co) and surrogate (Cs) character plus
 * the line and paragraph separators. That includes the zero-width joiner and variation selector 16
 * that emoji SEQUENCES use: a family or profession emoji is refused in a note. A single-codepoint
 * emoji is fine. Allowing the joiners only inside valid sequences would need an emoji grammar, and a
 * refusal that says why is cheaper than a parser that can be fooled.
 */
// Beyond the categories: variation selectors and the combining grapheme joiner (Mn), and the Hangul fillers, all invisible.
// The combining and variation characters in the class are the point: they are what must be refused.
// eslint-disable-next-line no-misleading-character-class
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\u034f\u115f\u1160\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;
// eslint-disable-next-line no-misleading-character-class
const UNSAFE_ALL = new RegExp(UNSAFE.source, 'gu');

export function hasUnsafeChars(s: string): boolean {
  return UNSAFE.test(s);
}

/** A JSON string literal with every unsafe character written out (\uXXXX, or \u{X} above the BMP), so one value is one visible, inert token. */
export function quote(s: string): string {
  return JSON.stringify(s).replace(UNSAFE_ALL, (c) => {
    const n = c.codePointAt(0) ?? 0;
    const hex = n.toString(16).padStart(4, '0');
    return n > 0xffff ? `\\u{${hex}}` : `\\u${hex}`;
  });
}

/** An agent id is a registry id or 'unknown', so it prints as is; anything else in the column is printed escaped. */
export function agentLabel(id: string | null): string {
  return id !== null && /^[a-z0-9-]{1,40}$/.test(id) ? id : quote(id ?? '');
}
