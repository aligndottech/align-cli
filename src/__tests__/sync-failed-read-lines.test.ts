import { describe, expect, it } from 'vitest';
import { failedReadLines } from '../lib/sync/launch-hook.js';
import type { SyncSummary } from '../lib/sync/summary-read.js';

/**
 * A background read that failed must say so where the person looks next, the agent screen, or an
 * empty graph reads as "nothing found".
 *
 * Test List:
 * - One source whose last run was an error: one line naming it and `align sync --status`.
 * - Two such sources: one line naming both.
 * - ok, partial, never and needs_reauth say nothing here (partial kept what it read; needs_reauth
 *   has its own reconnect line).
 * - No summary: nothing.
 */
const summary = (sources: Array<[string, SyncSummary['sources'][number]['status']]>): SyncSummary => ({
  version: 1, generated_at: '2026-11-09T12:00:00Z', sources: sources.map(([id, status]) => ({ id, status, backgroundEligible: true })),
});

describe('failedReadLines', () => {
  it('names one source whose last read failed', () => {
    expect(failedReadLines(summary([['jira', 'error'], ['linear', 'ok']]))).toEqual(['The last read of jira failed. See: align sync --status']);
  });
  it('names every failed source in one line', () => {
    expect(failedReadLines(summary([['jira', 'error'], ['slack', 'error']]))).toEqual(['The last read of jira, slack failed. See: align sync --status']);
  });
  it('says nothing for ok, partial, never or needs_reauth', () => {
    expect(failedReadLines(summary([['jira', 'ok'], ['slack', 'partial'], ['notion', 'never'], ['linear', 'needs_reauth']]))).toEqual([]);
  });
  it('says nothing with no summary', () => {
    expect(failedReadLines(undefined)).toEqual([]);
  });
});
