/**
 * Shell commands that change files. The edit gate only sees the edit and write tools, so a file
 * changed from the shell skips every decision check. The broker refuses these and tells the model
 * to use the edit tool. This is a floor, not a sandbox: a script file or a build step can still
 * write, and those still reach the person as a command.
 */

/** Interpreters that take a program inline (`-c`, `-e`, `-` or a heredoc) and can write any file. */
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl']);
const INLINE_FLAGS = new Set(['-c', '-e', '-', '-pi', '-i']);
/** Redirect targets that are not the repository. */
const HARMLESS_TARGET = /^(\/dev\/|\/tmp\/)/;

/** Quoted text masked as `x`, so a quoted `>` or `-i` is never read as syntax but a quoted path is still a word. */
function blankQuotes(command: string): string {
  let out = '';
  let quote: string | undefined;
  for (const c of command) {
    if (quote !== undefined) { if (c === quote) quote = undefined; out += 'x'; continue; }
    if (c === "'" || c === '"') { quote = c; out += 'x'; continue; }
    out += c;
  }
  return out;
}

/** A `>` or `>>` whose target is a file in the repo. `2>&1` and `>&2` point at a descriptor. */
function redirectsIntoFile(bare: string, original: string): boolean {
  for (const m of bare.matchAll(/\d?>>?/g)) {
    const at = (m.index ?? 0) + m[0].length;
    if (original[at] === '&') continue;
    const target = original.slice(at).trimStart().split(/\s/)[0]?.replace(/["']/g, '') ?? '';
    if (!HARMLESS_TARGET.test(target)) return true;
  }
  return false;
}

/** True when the command, or any part of it, changes a file through the shell. */
export function changesFiles(command: string): boolean {
  const bare = blankQuotes(command);
  if (redirectsIntoFile(bare, command)) return true;
  for (const segment of bare.split(/;|&&|\|\||\||\n/)) {
    const [head, ...rest] = segment.trim().split(/\s+/);
    if (head === undefined || head === '') continue;
    if (head === 'tee' && rest.some((t) => t !== '' && !t.startsWith('-') && !HARMLESS_TARGET.test(t))) return true;
    if (head === 'sed' && rest.some((t) => t === '--in-place' || /^-[a-zA-Z]*i/.test(t))) return true;
    if (INTERPRETERS.has(head) && (rest.some((t) => INLINE_FLAGS.has(t)) || segment.includes('<<'))) return true;
  }
  return false;
}

export const SHELL_WRITE_REFUSED =
  'Align: changing files from the shell skips the decision check, so this command was not run. Make the change with the edit tool, '
  + 'so it is checked against the recorded decisions. Run tests and builds with the shell as usual.';
