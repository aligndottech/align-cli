/**
 * LM: text from the graph or from a mark reaches a terminal and an agent's context. A decision
 * title comes from a Slack message or a PR, and a note comes from whoever wrote it, so neither is
 * printed raw: a control byte can move the cursor, hide a word (ESC [8m) or forge a whole row.
 */

/** C0, DEL and C1 controls, the line and paragraph separators, and the bidi overrides and isolates. */
// The point of this pattern is to match control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_ALL = new RegExp(UNSAFE.source, 'g');

export function hasUnsafeChars(s: string): boolean {
  return UNSAFE.test(s);
}

/** A JSON string literal with every unsafe character written as \uXXXX, so one value is one visible, inert token. */
export function quote(s: string): string {
  return JSON.stringify(s).replace(UNSAFE_ALL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** An agent id is a registry id or 'unknown', so it prints as is; anything else in the column is printed escaped. */
export function agentLabel(id: string | null): string {
  return id !== null && /^[a-z0-9-]{1,40}$/.test(id) ? id : quote(id ?? '');
}
