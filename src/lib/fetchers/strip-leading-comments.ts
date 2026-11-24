/**
 * Many repos open every ADR with HTML comment lines (an owner, a tool credit). Rendered markdown hides them, but the
 * stored text is read raw, so the first thing an agent saw of the decision was the comment. Only comments at the very
 * start go, with the blank lines after them; a comment after real text is the author's and stays.
 * A text that is nothing but comments is returned as it is: there is no decision to reach.
 */
export function stripLeadingHtmlComments(text: string): string {
  let rest = text;
  for (;;) {
    // The FIRST closing delimiter ends the comment, whatever follows it: text on the same line is the author's.
    const m = /^\s*<!--[\s\S]*?-->/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length).replace(/^[ \t]*\r?\n?/, '');
  }
  const stripped = rest.replace(/^\s*\n/, '');
  return stripped.trim() === '' ? text : stripped;
}
