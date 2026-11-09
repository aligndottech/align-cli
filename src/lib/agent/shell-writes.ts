/**
 * Shell commands that change files. The edit gate only sees the edit and write tools, so a file
 * changed from the shell skips every decision check. The broker refuses these and tells the model
 * to use the edit tool. This is a floor, not a sandbox: cp, mv, rm, a script file, a build step and a
 * formatter (prettier --write, eslint --fix) can still write, and those still reach the person as a command.
 *
 * A refusal cannot be overridden by the person, so a false refusal blocks the agent. Each rule is
 * therefore narrow: inline interpreter code is refused only when the code itself writes a file.
 */

/** python, python3, python3.11, node, ruby, perl, by name or absolute path. */
const INTERPRETER = /^(python(\d+(\.\d+)?)?|node|ruby|perl)$/;
/** Flags that hand an interpreter its program inline. `-` reads it from stdin. */
const INLINE_FLAGS = new Set(['-c', '-e', '-', '--eval', '-pe', '-ne']);
/**
 * A CALL that writes, moves or deletes a file. A bare `.write(` is not one: stdout, a child's stdin and an http reply all
 * write too, and refusing those would block the agent with no way past. Naming a function without calling it is not one.
 */
const WRITES_A_FILE = new RegExp([
  String.raw`\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][rbt]*[wax+]`,
  String.raw`\.write_(?:text|bytes)\s*\(`,
  String.raw`\b(?:write|append)File(?:Sync)?\s*\(`,
  String.raw`\bcreateWriteStream\s*\(`,
  String.raw`\b(?:unlink|rm|rmdir|rename|copyFile|cp)Sync\s*\(`,
  String.raw`\bFile\.(?:write|open|delete)\s*\(`,
  String.raw`\bos\.(?:remove|unlink|rename|replace|rmdir)\s*\(`,
  String.raw`\bshutil\.(?:copy\w*|move|rmtree)\s*\(`,
].join('|'));
/** Words that run the next word as the command. */
const WRAPPERS = new Set(['env', 'command', 'sudo', 'nice', 'nohup', 'exec']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

/** Heredoc bodies cut out of the command and returned apart, so their text is never read as shell. */
function splitHeredocs(command: string): { shell: string; bodies: string[] } {
  const lines = command.split('\n');
  const shell: string[] = [];
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    shell.push(line);
    for (const m of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/g)) {
      const body: string[] = [];
      while (++i < lines.length && lines[i]!.trim() !== m[2]) body.push(lines[i]!);
      bodies.push(body.join('\n'));
    }
  }
  return { shell: shell.join('\n'), bodies };
}

/**
 * Quoted text masked as `x` (same length, so positions still index the original), `#` comments
 * blanked, and backslash escapes honoured. A quoted `>` is never syntax; a quoted path is still a word.
 */
function mask(command: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '\\' && quote !== "'") { out += quote ? 'xx' : '  '; i++; continue; }
    if (quote !== undefined) { if (c === quote) quote = undefined; out += 'x'; continue; }
    if (c === "'" || c === '"') { quote = c; out += 'x'; continue; }
    if (c === '#' && (i === 0 || /\s/.test(command[i - 1]!))) {
      const end = command.indexOf('\n', i);
      const stop = end === -1 ? command.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
      continue;
    }
    out += c;
  }
  return out;
}

const unquote = (t: string): string => t.replace(/^(['"])([\s\S]*)\1$/, '$2');

/** /dev and /tmp are not the repository, unless the path climbs back out. */
const harmless = (target: string): boolean => /^(\/dev\/|\/tmp\/)/.test(target) && !target.split('/').includes('..');

/** A `>`, `>>`, `>|` or `&>` whose target is a file in the repo. `2>&1` and `>&2` point at a descriptor. */
function redirectsIntoFile(masked: string, original: string): boolean {
  for (const m of masked.matchAll(/&?\d*>[>|]?/g)) {
    const at = (m.index ?? 0) + m[0].length;
    if (original[at] === '&') continue;
    const target = unquote(original.slice(at).trimStart().split(/\s/)[0] ?? '');
    if (!harmless(target)) return true;
  }
  return false;
}

/** One segment's words, from the original text, with wrappers and assignments taken off the front. */
function commandWords(masked: string, original: string, start: number): string[] {
  const words: string[] = [];
  for (const m of masked.matchAll(/\S+/g)) words.push(original.slice(start + (m.index ?? 0), start + (m.index ?? 0) + m[0].length));
  while (words.length > 0) {
    const w = words[0]!.replace(/^[({]+/, '');
    if (w === '') { words.shift(); continue; }
    words[0] = w;
    if (/^[A-Za-z_]\w*=/.test(w) || WRAPPERS.has(w)) { words.shift(); continue; }
    if (w === 'timeout') { words.shift(); while (words[0]?.startsWith('-')) words.shift(); words.shift(); continue; }
    if (w === 'xargs') { words.shift(); while (words[0]?.startsWith('-')) words.shift(); continue; }
    break;
  }
  if (words[0] !== undefined) words[0] = words[0].split('/').pop()!;
  return words;
}

// perl and ruby -i, alone or clustered (-pi, -i.bak). A switch that takes an argument (-MList::Util, -rtime, -e) ends the
// cluster, so an i inside a module or library name is not -i.
function inPlaceSwitch(token: string): boolean {
  if (!/^-[a-zA-Z]/.test(token)) return false;
  for (const c of token.slice(1)) {
    if (c === 'i') return true;
    if ('MmIrFCDxeE'.includes(c) || !/[a-zA-Z]/.test(c)) return false;
  }
  return false;
}

function segmentChangesFiles(words: string[], segment: string, whole: string, bodies: string[], depth: number): boolean {
  const [head, ...rest] = words;
  if (head === undefined) return false;
  if (head === 'tee') return rest.some((t) => !t.startsWith('-') && !harmless(unquote(t)));
  if (head === 'sed') return rest.some((t) => /^--in-place/.test(t) || /^-[a-zA-Z]*i/.test(t));
  // awk can write from its own program (print > "file"), which the shell never sees.
  if (head === 'awk' || head === 'gawk') return rest.some((t, i) => t === '-i' && rest[i + 1] === 'inplace') || /\bprintf?\b[^;}]*>>?\s*"/.test(segment);
  // A patch carries arbitrary content into the repo.
  if (head === 'patch' || (head === 'git' && rest[0] === 'apply')) return true;
  if (SHELLS.has(head)) {
    const at = rest.indexOf('-c');
    return at !== -1 && rest[at + 1] !== undefined && depth < 3 && changesFilesAt(unquote(rest[at + 1]!), depth + 1);
  }
  if (!INTERPRETER.test(head)) return false;
  // perl and ruby -i edit in place; python and node -i are interactive.
  if ((head === 'perl' || head === 'ruby') && rest.some(inPlaceSwitch)) return true;
  const inline = rest.some((t) => INLINE_FLAGS.has(t)) || segment.includes('<<');
  // `-` takes the program from stdin, so its code is whatever was piped in: read the whole line.
  const code = rest.includes('-') ? whole : segment;
  return inline && (WRITES_A_FILE.test(code) || bodies.some((b) => WRITES_A_FILE.test(b)));
}

function changesFilesAt(command: string, depth: number): boolean {
  const { shell, bodies } = splitHeredocs(command);
  const masked = mask(shell);
  if (redirectsIntoFile(masked, shell)) return true;
  let start = 0;
  for (const part of masked.split(/(;|&&|\|\||\||\n)/)) {
    const segStart = start;
    start += part.length;
    if (/^(;|&&|\|\||\||\n)$/.test(part)) continue;
    const words = commandWords(part, shell, segStart);
    if (segmentChangesFiles(words, shell.slice(segStart, start), shell, bodies, depth)) return true;
  }
  return false;
}

/** True when the command, or any part of it, changes a file through the shell. */
export function changesFiles(command: string): boolean {
  return changesFilesAt(command, 0);
}

export const SHELL_WRITE_REFUSED =
  'Align: changing files from the shell skips the decision check, so this command was not run. Make the change with the edit tool, '
  + 'so it is checked against the recorded decisions. Run tests and builds with the shell as usual, and write scratch output under /tmp.';
