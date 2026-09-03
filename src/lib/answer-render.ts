/**
 * Turn a model's markdown-shaped answer into terminal text.
 *
 * The synthesis prompt asks for plain prose, and models still emit `**bold**` and
 * `code` spans, which a terminal shows as asterisks and backticks (Tom, 2026-09-03:
 * `Your team does **not** uniformly fail open`). This is the guarantee at the print
 * site, so it holds for every path that reaches the screen, cloud answers included:
 * inline bold becomes ANSI bold, a code span becomes a highlighted span, and an em- or
 * en-dash becomes the house " - " whatever spacing the model put around it. An
 * unmatched marker is left alone rather than eating text; a stray asterisk in prose
 * is rarer than a lost word.
 *
 * Deliberately not a markdown renderer: headings, lists and links are not what a
 * 2-4 sentence answer contains, and rendering them would invite the model to write
 * them.
 */
import chalk from 'chalk';

export function renderAnswer(text: string): string {
  return text
    .replace(/\*\*(\S(?:[^*]*?\S)?)\*\*/g, (_m, inner: string) => chalk.bold(inner))
    .replace(/`([^`\n]+)`/g, (_m, inner: string) => chalk.cyan(inner))
    .replace(/[^\S\r\n]*[–—][^\S\r\n]*/g, ' - ');
}
