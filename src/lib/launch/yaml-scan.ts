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
}

/**
 * One line, read on its own (no quote state carries to the next line). A quote opens a quoted
 * scalar only where a YAML node starts: after the indent, after `- `, after `: `, or after `[`, `{`
 * or `,`. Anywhere else (`Tom's`) it is a plain character. Returns where a comment starts (or the
 * line length), and whether the line holds something this reader does not follow: an escape in a
 * double-quoted scalar, a quoted scalar that does not close on the line, an anchor or alias at a
 * node start, or a complex key (`? `). When unsure, it says unfollowable.
 */
function scanLine(line: string): { comment: number; unfollowable: boolean } {
  let nodeStart = true;
  const space = (k: number) => k >= line.length || /\s/.test(line[k]!);
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (/\s/.test(c)) continue;
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return { comment: i, unfollowable: false };
    if (nodeStart) {
      if (c === '&' || c === '*') return { comment: line.length, unfollowable: true };
      if (c === '?' && space(i + 1)) return { comment: line.length, unfollowable: true };
      if (c === '"' || c === "'") {
        let j = i + 1;
        for (; j < line.length; j++) {
          if (c === '"' && line[j] === '\\') return { comment: line.length, unfollowable: true };
          if (line[j] === c) {
            if (c === "'" && line[j + 1] === "'") { j++; continue; }
            break;
          }
        }
        if (j >= line.length) return { comment: line.length, unfollowable: true };
        i = j;
        nodeStart = false;
        continue;
      }
      if (c === '-' && space(i + 1)) continue;
      if (c === '[' || c === '{') continue;
    }
    if ((c === ':' && space(i + 1)) || c === ',' || c === '[' || c === '{') {
      nodeStart = true;
      continue;
    }
    nodeStart = false;
  }
  return { comment: line.length, unfollowable: false };
}

/** Strip a trailing comment, by the same per-line rules. */
function stripComment(line: string): string {
  return line.slice(0, scanLine(line).comment);
}

/**
 * Constructs that can spell a name without its literal text, or that this reader cannot follow:
 * a byte order mark, a CR not followed by LF, and per line whatever `scanLine` cannot follow.
 */
function unfollowable(text: string): boolean {
  if (text.startsWith('\ufeff') || /\r(?!\n)/.test(text)) return true;
  return text.split(/\r?\n/).some((l) => scanLine(l).unfollowable);
}

/**
 * The lines that carry content, comments removed, with their indentation. null when the file is
 * outside what this reader follows (see `unfollowable`, and tab indentation): callers treat that
 * as a conflict, fail closed.
 */
export function meaningfulLines(text: string): YamlLine[] | null {
  if (unfollowable(text)) return null;
  const out: YamlLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).replace(/\s+$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (line.slice(0, indent).includes('\t')) return null;
    out.push({ indent, text: line.trim() });
  }
  return out;
}

/** A plain or quoted scalar's value; null for anything that is not a simple scalar. */
export function scalar(v: string): string | null {
  const s = v.trim();
  if (s === '' || /^[[{&*!|>%@`]/.test(s)) return null;
  if (s.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(s);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
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
