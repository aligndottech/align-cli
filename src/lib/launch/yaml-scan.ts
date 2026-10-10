/**
 * A deliberately narrow reader for the two YAML files wave C has to look inside (Goose's
 * config.yaml `extensions`, Continue's config.yaml `mcpServers`). align-cli ships no YAML parser
 * (js-yaml is a dev dependency only), and these files are only READ here, never written.
 *
 * It answers one question: does the file define an `align-local` server, and is it exactly
 * Align's own? It understands block mappings, block and flow lists of plain or quoted scalars,
 * and comments. Anything else that mentions align-local is reported as unplaceable, and the
 * callers treat that as a conflict: Align adds nothing and says so, rather than guessing.
 */
export interface YamlLine {
  indent: number;
  text: string;
  /** 1-based line number in the file. */
  n: number;
}

export interface Unreadable {
  line: number;
  reason: string;
}

const ANCHOR = 'a YAML anchor, alias, tag or merge key';

/**
 * A double-quoted YAML body (between the quotes) decoded the YAML way: `\\`, `\"`, `\/`, `\0`,
 * `\a`, `\b`, `\t`, `\n`, `\v`, `\f`, `\r`, `\e`, `\ `, `\N`, `\_`, `\L`, `\P`, `\xNN`, `\uNNNN`,
 * `\UNNNNNNNN`. null for an escape YAML does not define.
 */
export function decodeDoubleQuoted(body: string): string | null {
  const simple: Record<string, string> = { '\\': '\\', '"': '"', '/': '/', '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' };
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = body[i + 1];
    if (e === undefined) return null;
    const width = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
    if (width > 0) {
      const hex = body.slice(i + 2, i + 2 + width);
      if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) return null;
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff) return null;
      out += String.fromCodePoint(cp);
      i += 1 + width;
    } else if (Object.hasOwn(simple, e)) {
      out += simple[e];
      i += 1;
    } else {
      return null;
    }
  }
  return out;
}

/**
 * One line, read on its own (no quote state carries to the next line). A YAML node starts at the
 * line start (after the indent), after `- `, after `: `, after `[`, `{` or `,`, and after a quoted
 * key's closing quote and `:`. Only there do `!`, `&`, `*`, `<<`, `?` and quotes mean anything:
 * inside a plain scalar (`Be concise ! no fluff`, `Q & A`, `say 5" screens`) they are text.
 * Returns where a comment starts, whether the line opens a block scalar (`|` or `>`), and what
 * makes it unreadable, if anything. Conservative: when unsure, unreadable.
 */
function scanLine(line: string): { comment: number; blockHeader: boolean; unreadable?: string } {
  let nodeStart = true;
  let lastToken = '';
  const space = (k: number) => k >= line.length || /\s/.test(line[k]!);
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (/\s/.test(c)) continue;
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return { comment: i, blockHeader: /^[|>][-+0-9]*$/.test(lastToken) };
    if (nodeStart) {
      if (c === '!' || c === '&' || c === '*') return { comment: line.length, blockHeader: false, unreadable: ANCHOR };
      if (c === '<' && line[i + 1] === '<') return { comment: line.length, blockHeader: false, unreadable: ANCHOR };
      if (c === '?' && space(i + 1)) return { comment: line.length, blockHeader: false, unreadable: ANCHOR };
      if (c === '"' || c === "'") {
        let j = i + 1;
        let escaped = false;
        for (; j < line.length; j++) {
          if (c === '"' && line[j] === '\\') { escaped = true; j++; continue; }
          if (line[j] === c) {
            if (c === "'" && line[j + 1] === "'") { j++; continue; }
            break;
          }
        }
        if (j >= line.length) return { comment: line.length, blockHeader: false, unreadable: 'a quoted value that continues on the next line' };
        if (escaped) {
          const decoded = decodeDoubleQuoted(line.slice(i + 1, j));
          if (decoded === null) return { comment: line.length, blockHeader: false, unreadable: 'an escape Align does not read' };
          if (/align/i.test(decoded)) return { comment: line.length, blockHeader: false, unreadable: 'an escaped double-quoted value that may spell align-local' };
        }
        i = j;
        nodeStart = line[j + 1] === ':';
        if (nodeStart) i++;
        lastToken = 'q';
        continue;
      }
      if (c === '-' && space(i + 1)) { lastToken = '-'; continue; }
      if (c === '[' || c === '{') continue;
    }
    if ((c === ':' && space(i + 1)) || c === ',' || c === '[' || c === '{') {
      nodeStart = true;
      lastToken = c;
      continue;
    }
    // A plain token: read to the next space, so its characters are text.
    let j = i;
    while (j < line.length && !/\s/.test(line[j]!) && !(line[j] === ':' && space(j + 1)) && !(line[j] === ',' && /[\]}]/.test(line.slice(j)))) j++;
    lastToken = line.slice(i, j);
    i = j - 1;
    nodeStart = false;
  }
  return { comment: line.length, blockHeader: /^[|>][-+0-9]*$/.test(lastToken) };
}

/**
 * The file's content lines (comments removed, block-scalar bodies skipped), or why it cannot be
 * read with certainty. A block-scalar body cannot hold structure, so it is skipped, except one
 * whose whole value spells align-local (a folded `name: >-` could).
 */
export function scanYaml(text: string): { lines: YamlLine[] } | { unreadable: Unreadable } {
  if (text.startsWith('\ufeff')) return { unreadable: { line: 1, reason: 'a byte order mark' } };
  const cr = /\r(?!\n)/.exec(text);
  if (cr) return { unreadable: { line: text.slice(0, cr.index).split('\n').length, reason: 'a line ending Align does not read (CR)' } };
  const out: YamlLine[] = [];
  let block: { indent: number; body: string[]; n: number } | null = null;
  const endBlock = (): Unreadable | undefined => {
    if (block && block.body.join('').replace(/\s+/g, '').toLowerCase() === 'align-local') return { line: block.n, reason: 'a block value that spells align-local' };
    block = null;
    return undefined;
  };
  const raws = text.split(/\r?\n/);
  for (let k = 0; k < raws.length; k++) {
    const raw = raws[k]!;
    const indent = raw.length - raw.trimStart().length;
    if (block) {
      if (raw.trim() === '' || indent > block.indent) {
        block.body.push(raw);
        continue;
      }
      const bad = endBlock();
      if (bad) return { unreadable: bad };
    }
    if (raw.slice(0, indent).includes('\t')) return { unreadable: { line: k + 1, reason: 'tab indentation' } };
    const s = scanLine(raw);
    if (s.unreadable) return { unreadable: { line: k + 1, reason: s.unreadable } };
    const line = raw.slice(0, s.comment).replace(/\s+$/, '');
    if (line.trim() !== '') out.push({ indent, text: line.trim(), n: k + 1 });
    if (s.blockHeader) block = { indent, body: [], n: k + 1 };
  }
  const bad = endBlock();
  return bad ? { unreadable: bad } : { lines: out };
}

/** The content lines, or null when the file cannot be read with certainty (callers fail closed). */
export function meaningfulLines(text: string): YamlLine[] | null {
  const s = scanYaml(text);
  return 'lines' in s ? s.lines : null;
}

/** Where and why a file cannot be read with certainty; undefined when it can. */
export function yamlUnreadable(text: string): Unreadable | undefined {
  const s = scanYaml(text);
  return 'unreadable' in s ? s.unreadable : undefined;
}

/** A plain or quoted scalar's value; null for anything that is not a simple scalar. */
export function scalar(v: string): string | null {
  const s = v.trim();
  if (s === '' || /^[[{&*!|>%@`]/.test(s)) return null;
  if (s.startsWith('"')) return s.length >= 2 && s.endsWith('"') ? decodeDoubleQuoted(s.slice(1, -1)) : null;
  if (s.startsWith("'")) return s.length >= 2 && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : null;
  return s;
}

/** A flow list of simple scalars (`[a, "b"]`); null for anything else. */
function flowList(v: string): string[] | null {
  const s = v.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const inner = s.slice(1, -1).trim();
  if (inner === '') return [];
  const items: string[] = [];
  for (const part of inner.split(',')) {
    const item = scalar(part);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

/** One `key: value` of a mapping: the inline value, and the lines that belong under it. */
export interface Field {
  inline: string;
  children: YamlLine[];
}

const KEY = /^(?:"([^"]+)"|'([^']+)'|([^\s"'#][^:]*?))\s*:(?:\s+(.*))?$/;

/** Split a mapping's lines (all at `indent` or deeper) into fields; null when a line is not `key: value`. */
export function fields(lines: YamlLine[]): Map<string, Field> | null {
  const out = new Map<string, Field>();
  if (lines.length === 0) return out;
  const indent = lines[0]!.indent;
  let current: Field | undefined;
  for (const line of lines) {
    // A block list may sit at its key's own indentation (`args:` then `- mcp`).
    if (line.indent > indent || (current && line.indent === indent && line.text.startsWith('- ') && current.inline === '')) {
      if (!current) return null;
      current.children.push(line);
      continue;
    }
    if (line.indent < indent) return null;
    const m = KEY.exec(line.text);
    if (!m) return null;
    const key = m[1] ?? m[2] ?? m[3]!;
    if (out.has(key)) return null;
    current = { inline: m[4] ?? '', children: [] };
    out.set(key, current);
  }
  return out;
}

/** A field's string list: flow (`[a, b]`) or block (`- a` lines); null for anything else. */
export function listValue(f: Field): string[] | null {
  if (f.inline !== '') return f.children.length === 0 ? flowList(f.inline) : null;
  const items: string[] = [];
  for (const c of f.children) {
    if (!c.text.startsWith('- ')) return null;
    const item = scalar(c.text.slice(2));
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

/** A field's scalar; null when it is a list, a map or nothing. */
export function scalarValue(f: Field | undefined): string | null {
  return f && f.children.length === 0 ? scalar(f.inline) : null;
}

/**
 * The lines of a top-level block (`<key>:` at column 0), up to the next top-level line. null when
 * the key is absent; 'inline' when it carries a flow value on its own line.
 */
export function topLevelBlock(lines: YamlLine[], key: string): YamlLine[] | 'inline' | null {
  const i = lines.findIndex((l) => l.indent === 0 && KEY.exec(l.text)?.slice(1, 4).some((k) => k === key));
  if (i < 0) return null;
  if ((KEY.exec(lines[i]!.text)![4] ?? '') !== '') return 'inline';
  // YAML lets a block list sit at its key's own column (`key:` then `- item` at column 0).
  const block: YamlLine[] = [];
  let zeroList = false;
  for (const l of lines.slice(i + 1)) {
    if (l.indent === 0) {
      if (!l.text.startsWith('- ') || (block.length > 0 && !zeroList)) break;
      zeroList = true;
    }
    block.push(l);
  }
  return block;
}

