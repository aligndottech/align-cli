/**
 * Which shell commands the broker lets through without asking. The rule is an allowlist over a
 * parse that fails toward asking: anything this file cannot positively read as read-only is not.
 *
 * A command is one or more segments joined by `;`, `&&`, `||` or `|`. EVERY segment must be a
 * known read-only command, so an allowed `git status` cannot approve what follows it. Characters
 * that run or write something else (substitution, redirects, background jobs, newlines, escapes)
 * reject the whole line. A quoted `;` splits wrongly, and that only ever produces a segment that
 * fails the allowlist, so the mistake costs a question and never a pass.
 */

const SHELL_SYNTAX = /[`$<>(){}\\\n\r]/;

const PLAIN = new Set(['ls', 'pwd', 'head', 'tail', 'wc', 'echo', 'true', 'grep', 'which', 'test']);
const GIT_READ = new Set(['status', 'log', 'show', 'diff', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'shortlog', 'describe']);
const GIT_FLAGS_THAT_RUN_OR_WRITE = ['--output', '--ext-diff', '--textconv', '--exec'];
const FIND_FLAGS_THAT_RUN_OR_WRITE = ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'];

/** What the shell hands the program: every quote removed, so `-d""elete` reads as `-delete`. */
const unquote = (t: string): string => t.replace(/["']/g, '');

/**
 * A git option that runs or writes, including git's unambiguous abbreviations of it
 * (`--outp=x` is `--output=x`). Four characters is the shortest prefix, so `--out` counts.
 */
function isRiskyGitFlag(token: string): boolean {
  const name = token.split('=')[0] ?? '';
  return name.length >= 4 && GIT_FLAGS_THAT_RUN_OR_WRITE.some((f) => f.startsWith(name));
}

/**
 * Splits on `;`, `&&`, `||` and `|` that sit outside quotes, so `grep 'a;b' f` stays one command.
 * Returns undefined for an unbalanced quote: a line this cannot read is a line that asks.
 */
function splitOutsideQuotes(command: string): string[] | undefined {
  const segments: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === ';' || c === '|' || c === '&') {
      const double = command[i + 1] === c && c !== ';';
      // A lone & is a background job. Keep it in the segment so the segment check rejects it.
      if (c === '&' && !double) { current += c; continue; }
      segments.push(current);
      current = '';
      if (double) i++;
    } else {
      current += c;
    }
  }
  if (quote !== undefined) return undefined;
  segments.push(current);
  return segments;
}

/** True when this one command, with no chaining, can only read. */
function segmentIsReadOnly(segment: string): boolean {
  if (segment.includes('&')) return false;
  const tokens = segment.trim().split(/\s+/).map(unquote).filter((t) => t !== '');
  const [head, second, ...rest] = tokens;
  if (head === undefined) return false;
  if (PLAIN.has(head)) return true;
  if (head === 'command') return second === '-v';
  if (head === 'node') return second === '--version' || second === '-v';
  if (head === 'find') return ![second, ...rest].some((t) => t !== undefined && FIND_FLAGS_THAT_RUN_OR_WRITE.includes(t));
  if (head === 'git') {
    // The subcommand must come first: `git -c core.pager=sh log` would run a program.
    if (second === undefined || !GIT_READ.has(second)) return false;
    return !rest.some(isRiskyGitFlag);
  }
  return false;
}

/** True when any segment of the line runs git, which can run programs the repo's config names. */
export function commandUsesGit(command: string): boolean {
  const segments = splitOutsideQuotes(command) ?? [];
  return segments.some((s) => unquote(s.trim().split(/\s+/)[0] ?? '') === 'git');
}

/** True only when every segment of the line is a known read-only command. */
export function isReadOnlyCommand(command: string): boolean {
  if (command.trim() === '' || SHELL_SYNTAX.test(command)) return false;
  const segments = splitOutsideQuotes(command);
  return segments !== undefined && segments.every(segmentIsReadOnly);
}
