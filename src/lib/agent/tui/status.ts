/**
 * The line under the transcript while a turn runs, so the screen is never still while the model
 * works: a spinner, a word that changes every few seconds, the time so far, and how to stop.
 * While a tool runs it says what the tool is doing instead of a word. Pure, so it is testable
 * without a terminal; app.ts owns the timers.
 */

export const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
export const SPINNER_INTERVAL_MS = 120;
/** How long one word stays before the next. */
export const WORD_PERIOD_MS = 3000;

export const THINKING_WORDS = [
  'Thinking', 'Pondering', 'Mulling it over', 'Discombobulating', 'Cross-referencing', 'Untangling',
  'Weighing precedent', 'Rummaging', 'Percolating', 'Deliberating', 'Reconciling', 'Noodling',
  'Joining the dots', 'Spelunking', 'Consulting the archives', 'Ruminating', 'Puzzling', 'Sifting',
];

/** What a running tool is doing, in words, or undefined to keep rotating. Engines name tools
 *  differently (Claude Code prefixes MCP tools with `mcp__<server>__`; pi uses lowercase names). */
export function toolActivity(tool: string): string | undefined {
  const t = tool.toLowerCase();
  if (/align_(ask|search)\b/.test(t)) return 'Asking the decision graph';
  if (/align_check/.test(t)) return 'Checking against your decisions';
  if (t.includes('align_')) return 'Reading the decision graph';
  if (t === 'bash') return 'Running a command';
  if (t === 'read') return 'Reading';
  if (t === 'edit' || t === 'write' || t === 'multiedit') return 'Editing';
  if (t === 'grep' || t === 'glob' || t === 'find' || t === 'ls') return 'Searching';
  if (t === 'webfetch' || t === 'websearch') return 'Reading the web';
  return undefined;
}

/** The word for this moment: changes every WORD_PERIOD_MS, starting at `seed` so turns differ. */
export function wordAt(seed: number, elapsedMs: number): string {
  const n = THINKING_WORDS.length;
  const i = (((seed + Math.floor(Math.max(0, elapsedMs) / WORD_PERIOD_MS)) % n) + n) % n;
  return THINKING_WORDS[i]!;
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function statusMessage(o: { word: string; elapsedMs: number }): string {
  return `${o.word}… (${formatElapsed(o.elapsedMs)} · esc to interrupt)`;
}
