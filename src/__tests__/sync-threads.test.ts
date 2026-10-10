import { describe, expect, it } from 'vitest';
import { HOT_THREAD_DAYS, mergePartialThread, parseSlackPermalink, selectHotThreads } from '../lib/sync/threads.js';

/**
 * L5 Test List (Slack hot threads and partial merges; pure):
 * - Given a Slack thread with a reply in the last 30 days, it is in the next run's hotThreads. Given one quiet for 31 days, it is not,
 *   and the quiet count is returned so the report can name that limit once.
 * - A partial item (a hot-thread re-read) is MERGED into the stored thread, never replaces it (Review addendum 3):
 *   new messages are appended, repeats are not, the stored text is never lost, and merging twice changes nothing.
 */
const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
const url = (channel: string, ts: string) => `https://slack.com/archives/${channel}/p${ts.replace('.', '')}`;

describe('parseSlackPermalink', () => {
  it('reads channel and thread-root ts from the SDK\'s own thread URL (two examples)', () => {
    expect(parseSlackPermalink(url('C0123ABC', '1700000000.123456'))).toEqual({ channel: 'C0123ABC', ts: '1700000000.123456' });
    expect(parseSlackPermalink(url('G9', '1690000000.000001'))).toEqual({ channel: 'G9', ts: '1690000000.000001' });
  });
  it('anything else is undefined, not a guess', () => {
    expect(parseSlackPermalink('https://github.com/o/r/pull/1')).toBeUndefined();
    expect(parseSlackPermalink('https://slack.com/archives/C1/pshort')).toBeUndefined();
    expect(parseSlackPermalink('')).toBeUndefined();
  });
});

describe('selectHotThreads', () => {
  it('a thread with activity 29 days ago is hot; 31 days ago is not, and is counted as quiet', () => {
    const r = selectHotThreads([
      { source_url: url('C1', '1700000001.000001'), last_activity: ago(29) },
      { source_url: url('C1', '1700000002.000001'), last_activity: ago(31) },
    ], NOW);
    expect(r.hot).toEqual([{ channel: 'C1', ts: '1700000001.000001' }]);
    expect(r.quiet).toBe(1);
    expect(HOT_THREAD_DAYS).toBe(30);
  });

  it('exactly 30 days is still hot (the boundary is inclusive); one minute past is quiet', () => {
    const r = selectHotThreads([
      { source_url: url('C1', '1700000001.000001'), last_activity: ago(30) },
      { source_url: url('C1', '1700000002.000001'), last_activity: new Date(NOW.getTime() - 30 * DAY - 60_000).toISOString() },
    ], NOW);
    expect(r.hot.map((h) => h.ts)).toEqual(['1700000001.000001']);
    expect(r.quiet).toBe(1);
  });

  it('newest activity first, and capped; the cut is counted as quiet-by-cap in `capped`', () => {
    const rows = [1, 2, 3].map((n) => ({ source_url: url('C1', `170000000${n}.000001`), last_activity: ago(n) }));
    const r = selectHotThreads(rows, NOW, { limit: 2 });
    expect(r.hot.map((h) => h.ts)).toEqual(['1700000001.000001', '1700000002.000001']);
    expect(r.capped).toBe(1);
  });

  it('a row with no known activity, or an unreadable stamp, is quiet; a url that is not a thread is ignored', () => {
    const r = selectHotThreads([
      { source_url: url('C1', '1700000001.000001'), last_activity: null },
      { source_url: url('C1', '1700000002.000001'), last_activity: 'garbage' },
      { source_url: 'https://github.com/o/r/pull/1', last_activity: ago(1) },
    ], NOW);
    expect(r.hot).toEqual([]);
    expect(r.quiet).toBe(2);
  });
});

describe('mergePartialThread', () => {
  const head = '[#eng] Thread:';
  const stored = `${head}\nroot: should we use a queue?\nalice: yes, SQS\nbob: agreed`;

  it('appends only the messages the stored text does not have', () => {
    const partial = `${head}\nroot: should we use a queue?\nbob: agreed\ncarol: shipping it Friday`;
    expect(mergePartialThread(stored, partial)).toBe(`${stored}\ncarol: shipping it Friday`);
  });

  it('a partial of only new messages (no root, no overlap) is appended after the stored thread (second example)', () => {
    const partial = `${head}\ncarol: shipping it Friday\ndave: +1`;
    expect(mergePartialThread(stored, partial)).toBe(`${stored}\ncarol: shipping it Friday\ndave: +1`);
  });

  it('never loses the stored text: the result always starts with it', () => {
    const partial = `${head}\nzed: something unrelated`;
    expect(mergePartialThread(stored, partial).startsWith(stored)).toBe(true);
  });

  it('merging the same partial twice changes nothing (a re-run is safe)', () => {
    const partial = `${head}\nroot: should we use a queue?\nbob: agreed\ncarol: shipping it Friday`;
    const once = mergePartialThread(stored, partial);
    expect(mergePartialThread(once, partial)).toBe(once);
  });

  it('a partial that is already wholly inside the stored thread adds nothing', () => {
    expect(mergePartialThread(stored, `${head}\nalice: yes, SQS\nbob: agreed`)).toBe(stored);
  });

  it('a different header line is ignored, never appended as a message', () => {
    const partial = `[#renamed] Thread:\ncarol: shipping it Friday`;
    expect(mergePartialThread(stored, partial)).toBe(`${stored}\ncarol: shipping it Friday`);
  });
});
