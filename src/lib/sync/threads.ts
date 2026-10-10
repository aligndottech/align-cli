/**
 * L5: the thread side of a sync - which stored Slack threads to ask the SDK to re-read (a reply to
 * an old thread never shows up in a date-ordered channel listing), and how a re-read that holds
 * only the NEW messages is folded into the stored thread.
 *
 * Pure. The SDK marks such an item `partial: true`; Review addendum 3 binds this file: a partial
 * item is merged into the stored row and never replaces it.
 */

/** A thread with a reply inside this many days is re-read by every run. */
export const HOT_THREAD_DAYS = 30;
/** Each re-read costs a vendor request, so a run reads at most this many; newest activity first. */
export const HOT_THREAD_LIMIT = 100;
const DAY_MS = 86_400_000;

/** The channel id and thread-root ts out of the URL connector-core writes for a thread. */
export function parseSlackPermalink(url: string): { channel: string; ts: string } | undefined {
  const m = /^https:\/\/slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(url);
  return m ? { channel: m[1]!, ts: `${m[2]}.${m[3]}` } : undefined;
}

export interface HotSelection {
  hot: Array<{ channel: string; ts: string }>;
  /** Threads held with no reply inside the window. The report names this limit once. */
  quiet: number;
  /** Threads that were hot but did not fit under the per-run limit. */
  capped: number;
}

export function selectHotThreads(
  rows: ReadonlyArray<{ source_url: string; last_activity: string | null }>,
  now: Date,
  o: { limit?: number } = {},
): HotSelection {
  const cutoff = now.getTime() - HOT_THREAD_DAYS * DAY_MS;
  const hot: Array<{ channel: string; ts: string; at: number }> = [];
  let quiet = 0;
  for (const row of rows) {
    const thread = parseSlackPermalink(row.source_url);
    if (thread === undefined) continue;
    const at = row.last_activity === null ? Number.NaN : Date.parse(row.last_activity);
    // NaN (no activity recorded, or a stamp nobody can read) is quiet, not hot: a hot thread costs a request.
    if (Number.isNaN(at) || at < cutoff) quiet += 1;
    else hot.push({ ...thread, at });
  }
  hot.sort((a, b) => b.at - a.at);
  const limit = o.limit ?? HOT_THREAD_LIMIT;
  return { hot: hot.slice(0, limit).map(({ channel, ts }) => ({ channel, ts })), quiet, capped: Math.max(0, hot.length - limit) };
}

const HEADER = /^\[#[^\]\n]*\] Thread:$/;

function bodyLines(text: string): { header: string | undefined; lines: string[] } {
  const all = text.split('\n');
  return HEADER.test(all[0] ?? '') ? { header: all[0], lines: all.slice(1) } : { header: undefined, lines: all };
}

function sameRun(a: readonly string[], aAt: number, b: readonly string[], bAt: number, n: number): boolean {
  for (let i = 0; i < n; i++) if (a[aAt + i] !== b[bAt + i]) return false;
  return true;
}

/**
 * The stored thread plus whatever the partial read holds that it does not. The SDK's text is the
 * thread's messages joined by newlines with no timestamps, so "already there" can only be judged
 * by comparing runs of lines:
 * 1. the longest tail of the stored thread that the partial also holds contiguously: everything
 *    after that run in the partial is new;
 * 2. else the partial wholly inside the stored thread: nothing is new;
 * 3. else drop the partial's leading lines that repeat the stored thread's opening (the root,
 *    which Slack returns again) and append the rest.
 * A message that repeats an earlier line word for word (an "ok") is the one thing this cannot
 * tell from an overlap; the longest-run rule makes that need a run, not one line, to confuse it.
 * The stored text is never altered, so a merge can only add.
 */
export function mergePartialThread(stored: string, partial: string): string {
  const s = bodyLines(stored).lines;
  const p = bodyLines(partial).lines;
  for (let k = Math.min(s.length, p.length); k >= 1; k--) {
    for (let j = 0; j + k <= p.length; j++) {
      if (sameRun(s, s.length - k, p, j, k)) return append(stored, p.slice(j + k));
    }
  }
  for (let at = 0; at + p.length <= s.length; at++) if (p.length > 0 && sameRun(s, at, p, 0, p.length)) return stored;
  let head = 0;
  while (head < p.length && head < s.length && p[head] === s[head]) head++;
  return append(stored, p.slice(head));
}

function append(stored: string, added: readonly string[]): string {
  return added.length === 0 ? stored : `${stored}\n${added.join('\n')}`;
}
