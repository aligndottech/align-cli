/**
 * What a failed tool call shows the person: the last few lines of what the tool said, which for a
 * shell command carries the exit code and stderr. Engines hand over a result in different shapes
 * (a string, a list of text blocks, an object holding either), so this reads all of them and
 * returns nothing when there is no text, rather than inventing a reason.
 */

const MAX_LINES = 3;
const MAX_LINE_CHARS = 200;

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).filter((t) => t !== '').join('\n');
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return textOf(typeof o['text'] === 'string' ? o['text'] : o['content']);
  }
  return '';
}

export function failureTail(result: unknown): string | undefined {
  const lines = textOf(result).split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return undefined;
  return lines.slice(-MAX_LINES).map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS - 1)}…` : l)).join('\n');
}
