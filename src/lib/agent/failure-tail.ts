/**
 * What a failed tool call shows the person: the last few lines of what the tool said, which for a
 * shell command carries the exit code and stderr. Engines hand over a result in different shapes
 * (a string, a list of text blocks, an object holding either), so this reads all of them and
 * returns nothing when there is no text, rather than inventing a reason.
 */

const MAX_LINES = 3;
const MAX_LINE_CHARS = 200;

/** The text inside a tool result, whatever shape the engine used. */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).filter((t) => t !== '').join('\n');
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return textOf(typeof o['text'] === 'string' ? o['text'] : o['content']);
  }
  return '';
}

/**
 * Tool output is untrusted text going to the person's terminal. Drop escape sequences (a stray
 * `ESC[2J` would clear the screen) and other control characters, keeping line breaks.
 */
function stripTerminalControls(text: string): string {
  /* eslint-disable no-control-regex -- matching control characters is the job here */
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
  /* eslint-enable no-control-regex */
}

/** The last few lines of a failed tool's result, safe to print, or undefined when it said nothing. */
export function failureTail(result: unknown): string | undefined {
  const lines = stripTerminalControls(textOf(result)).split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return undefined;
  return lines.slice(-MAX_LINES).map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS - 1)}…` : l)).join('\n');
}
