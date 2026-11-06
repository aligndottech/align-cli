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
const SEPARATORS = /&&|\|\||;|\|/;

const PLAIN = new Set(['ls', 'pwd', 'head', 'tail', 'wc', 'echo', 'true', 'grep', 'which', 'test']);
const GIT_READ = new Set(['status', 'log', 'show', 'diff', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'shortlog', 'describe']);
const GIT_FLAGS_THAT_RUN_OR_WRITE = ['--output', '--ext-diff', '--textconv', '--exec'];
const FIND_FLAGS_THAT_RUN_OR_WRITE = ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'];

const unquote = (t: string): string => t.replace(/^["']+|["']+$/g, '');

function segmentIsReadOnly(segment: string): boolean {
  if (segment.includes('&')) return false; // a lone & is a background job
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
    return !rest.some((t) => GIT_FLAGS_THAT_RUN_OR_WRITE.some((f) => t === f || t.startsWith(`${f}=`)));
  }
  return false;
}

export function isReadOnlyCommand(command: string): boolean {
  if (command.trim() === '' || SHELL_SYNTAX.test(command)) return false;
  return command.split(SEPARATORS).every(segmentIsReadOnly);
}
