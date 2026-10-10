import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type CaptureSource, renderCaptureReport, toCaptureSource } from '../lib/capture-report.js';
import { withCaptureReport } from '../lib/fetchers/capture.js';

/**
 * L3: the capture report for a WINDOWED read. A complete read says what window it covered; an
 * incomplete one names the date it actually reached and the skip that stopped it (Decision 5);
 * a GitHub first pass says its discussion is still to come.
 */
const github = (over: Partial<CaptureSource>): CaptureSource => ({
  label: 'GitHub', unit: 'PRs and issues', fetched: 412, skips: [], window: 'the last 6 months', complete: true, ...over,
});
const lines = (s: CaptureSource[]) => renderCaptureReport(s).split('\n');

describe('a complete windowed read', () => {
  it('says what it imported and over which window', () => {
    expect(lines([github({})])).toEqual(['  Capture report', '    GitHub: imported 412 PRs and issues from the last 6 months']);
  });

  it('names the window it was given, not a constant (second example)', () => {
    expect(lines([github({ fetched: 9, window: 'the last 14 days' })])[1]).toBe('    GitHub: imported 9 PRs and issues from the last 14 days');
  });

  it('does not print the "of up to N requested" shortfall: a ceiling is not a target', () => {
    expect(renderCaptureReport([github({ fetched: 5, requested: 3_000 })])).not.toContain('requested');
  });

  it('with no window ("all") says the ceiling-bounded history, not a date', () => {
    expect(lines([github({ window: 'all the history the ceiling allowed' })])[1]).toBe(
      '    GitHub: imported 412 PRs and issues from all the history the ceiling allowed',
    );
  });
});

describe('an incomplete windowed read', () => {
  const cut = { kind: 'vendor_cap', count: 1, detail: 'search stopped at GitHub\'s 1,000-result ceiling' };

  it('names the date it reached and the skip that stopped it, and still lists the skip', () => {
    const out = lines([github({ fetched: 312, complete: false, oldestReached: '2026-05-02T09:30:00.000Z', skips: [cut] })]);
    expect(out[1]).toBe(
      "    GitHub: imported 312 PRs and issues, back to 2026-05-02 (not the last 6 months): search stopped at GitHub's 1,000-result ceiling",
    );
    expect(out[2]).toBe("      1 search stopped at GitHub's 1,000-result ceiling");
  });

  it('quotes the FIRST skip that left something unread, skipping a shape note that did not', () => {
    const shape = { kind: 'shape', count: 1, detail: 'options not used as given: maxChannels 0 is not a whole number of at least 1; used 200' };
    const budget = { kind: 'time_budget', count: 4, detail: 'channels not scanned (the 8 minute Slack time budget ran out)' };
    const out = lines([github({ label: 'Slack', unit: 'threads', complete: false, oldestReached: '2026-07-01T00:00:00Z', skips: [shape, budget] })]);
    expect(out[1]).toContain('back to 2026-07-01 (not the last 6 months): channels not scanned (the 8 minute Slack time budget ran out)');
    expect(out[1]).not.toContain('options not used');
  });

  it('with no skip at all, blames the ceiling only when the read reached it', () => {
    const atCeiling = lines([github({ fetched: 3_000, requested: 3_000, complete: false, oldestReached: '2026-06-01T00:00:00Z' })]);
    expect(atCeiling[1]).toContain('stopped at the ceiling of 3000');
    const below = lines([github({ fetched: 40, requested: 3_000, complete: false, oldestReached: '2026-06-01T00:00:00Z' })]);
    expect(below[1]).not.toContain('ceiling');
    expect(below[1]).toContain('did not reach the end of the window');
  });

  it('a read refused before any request (a shape skip, nothing read) quotes that refusal', () => {
    const refusal = { kind: 'shape', count: 1, detail: 'since is not a date (expected ISO-8601); nothing was read' };
    const out = lines([github({ fetched: 0, complete: false, skips: [refusal] })])[1]!;
    expect(out).toContain('read stopped early (not the last 6 months): since is not a date (expected ISO-8601); nothing was read');
  });

  it('without an oldest date says it could not tell how far back it got, and invents none', () => {
    const out = lines([github({ fetched: 0, complete: false, skips: [cut] })])[1]!;
    expect(out).toContain('read stopped early (not the last 6 months)');
    expect(out).not.toMatch(/back to/);
  });
});

describe('the GitHub discussion clause says what was fetched, and promises nothing', () => {
  const clause = 'discussion fetched for 188 of 312, the rest stay thin until align sync (not available yet)';

  it('counts the items that got their discussion against those that could have', () => {
    expect(lines([github({ discussionPending: 124, discussionTotal: 312 })])[1]).toBe(
      `    GitHub: imported 412 PRs and issues from the last 6 months; ${clause}`,
    );
  });

  it('a second count (two examples)', () => {
    expect(lines([github({ discussionPending: 1, discussionTotal: 4 })])[1]).toContain('discussion fetched for 3 of 4, the rest stay thin');
  });

  it('is absent when everything got its discussion, when none was pending, and when nothing was counted', () => {
    expect(renderCaptureReport([github({ discussionPending: 0, discussionTotal: 9 })])).not.toContain('discussion');
    expect(renderCaptureReport([github({ discussionPending: 0 })])).not.toContain('discussion');
    expect(renderCaptureReport([github({})])).not.toContain('discussion');
  });

  it('also follows an incomplete line', () => {
    const out = lines([github({ complete: false, oldestReached: '2026-05-02T00:00:00Z', discussionPending: 5, discussionTotal: 10,
      skips: [{ kind: 'page_cap', count: 1, detail: 'cut' }] })])[1];
    expect(out).toMatch(/: cut; discussion fetched for 5 of 10, the rest stay thin/);
  });

  it('never says a background pass is adding it: no such pass exists until L5 (source and docs are swept)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ['../lib/capture-report.ts', '../lib/fetchers/github.ts', '../commands/setup.ts', '../commands/import/github.ts', '../../docs/importing.md']) {
      expect(readFileSync(join(here, f), 'utf8'), f).not.toMatch(/being added in the background|follows in the background/);
    }
  });
});

describe('a source with no window keeps the old line', () => {
  it('prints exactly what ALI-827 printed', () => {
    expect(lines([{ label: 'Git', unit: 'commits', fetched: 8, skips: [] }])).toEqual(['  Capture report', '    Git: 8 commits']);
  });
});

describe('withCaptureReport carries the SDK report through', () => {
  const sdkResult = (over: Record<string, unknown> = {}, items: Array<Record<string, unknown>> = []) => ({
    items,
    report: {
      platform: 'github', scanned: 3, requested: 3000, skips: [{ kind: 'vendor_cap', count: 1, detail: 'cut' }],
      complete: false, scope: 'team', oldestReached: '2026-05-02T00:00:00Z', highWater: '2026-10-09T00:00:00Z', ...over,
    },
  });

  it('keeps complete, the oldest date reached, the scope and each skip kind', async () => {
    const r = await withCaptureReport({ limit: 3000 }, { fetch: async () => [], fetchWithReport: async () => sdkResult() as never });
    expect(r.report).toMatchObject({ complete: false, oldestReached: '2026-05-02T00:00:00Z', scope: 'team' });
    expect(r.report.skips).toEqual([{ kind: 'vendor_cap', count: 1, detail: 'cut' }]);
  });

  it('counts the items waiting for their discussion', async () => {
    const items = [{ detail_pending: true }, { detail_pending: false }, {}, { detail_pending: true }];
    const r = await withCaptureReport({}, { fetch: async () => [], fetchWithReport: async () => sdkResult({}, items) as never });
    expect(r.report.discussionPending).toBe(2);
  });

  it('leaves the window fields out when the SDK reports none (older report shape)', async () => {
    const r = await withCaptureReport({}, { fetch: async () => [], fetchWithReport: async () => ({ items: [], report: { scanned: 0, skips: [] } }) as never });
    expect(r.report.complete).toBeUndefined();
    expect('oldestReached' in r.report).toBe(false);
  });

  it('toCaptureSource passes them on, and the caller adds the window label', () => {
    const src = toCaptureSource({ label: 'GitHub', unit: 'PRs and issues' }, {
      items: [], report: { scanned: 0, skips: [], complete: true, discussionPending: 4, discussionTotal: 9 },
    }, 'the last 6 months');
    expect(src).toMatchObject({ window: 'the last 6 months', complete: true, discussionPending: 4, discussionTotal: 9 });
  });
});
