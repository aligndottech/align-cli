import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_DISCUSSION_BUDGET } from '../../lib/import-defaults.js';

/**
 * L3 review 3: GitHub's first import reads items, then fetches discussion INLINE up to
 * GITHUB_DISCUSSION_BUDGET core requests (the SDK's own fetchGitHubDiscussion, newest first), and
 * says truthfully how many got it. The rest stay `detail_pending` and thin; nothing here claims a
 * background drain, because none exists until L5. No real GitHub: both SDK entry points are doubles.
 */
const fetchWithReport = vi.hoisted(() => vi.fn());
const drain = vi.hoisted(() => vi.fn());
vi.mock('@aligndottech/connector-core', () => ({
  GitHubFetcher: class {
    fetchWithReport = fetchWithReport;
  },
  fetchGitHubDiscussion: drain,
}));

const { fetchGitHubItems } = await import('../../lib/fetchers/github.js');

const thin = (n: number) => ({ source_url: `https://github.com/o/r/pull/${n}`, platform: 'github', raw_text: `body ${n}`, detail_pending: true });
const full = (n: number) => ({ source_url: `https://github.com/o/r/pull/${n}`, platform: 'github', raw_text: `body ${n}\n\ncomments ${n}`, detail_pending: false });
const listResult = (items: unknown[]) => ({ items, report: { platform: 'github', scanned: items.length, skips: [], complete: true, scope: 'yours' as const } });

beforeEach(() => {
  fetchWithReport.mockReset();
  drain.mockReset();
});

describe('items first, then a budgeted discussion pass', () => {
  it('reads the list with discussion: none whatever the caller passed, then drains the pending items with the budget', async () => {
    fetchWithReport.mockResolvedValue(listResult([thin(1), thin(2)]));
    drain.mockResolvedValue({ items: [full(1), full(2)], skips: [], requests: 6 });
    await fetchGitHubItems({ token: 'tok', limit: 3000, discussion: 'full' as never });
    expect(fetchWithReport.mock.calls[0]![0]).toMatchObject({ discussion: 'none', token: 'tok' });
    expect(drain).toHaveBeenCalledWith([thin(1), thin(2)], { token: 'tok', maxRequests: GITHUB_DISCUSSION_BUDGET });
    expect(GITHUB_DISCUSSION_BUDGET).toBe(600);
  });

  it('puts the enriched items back in their original order and leaves the unreached ones thin', async () => {
    fetchWithReport.mockResolvedValue(listResult([thin(1), thin(2), thin(3)]));
    drain.mockResolvedValue({
      items: [full(3), full(1)], // the SDK drains newest first, so the order it returns is its own
      skips: [{ kind: 'page_cap', count: 1, detail: 'items whose discussion was not read: the request budget of 600 ran out' }],
      requests: 600,
    });
    const r = await fetchGitHubItems({ token: 't' });
    expect(r.items).toEqual([full(1), thin(2), full(3)]);
    expect(r.report).toMatchObject({ discussionTotal: 3, discussionPending: 1 });
    expect(r.report.skips).toEqual([{ kind: 'page_cap', count: 1, detail: 'items whose discussion was not read: the request budget of 600 ran out' }]);
  });

  it('a custom budget is passed through (two examples)', async () => {
    fetchWithReport.mockResolvedValue(listResult([thin(1)]));
    drain.mockResolvedValue({ items: [], skips: [], requests: 0 });
    await fetchGitHubItems({ token: 't', discussionBudget: 30 });
    expect(drain).toHaveBeenCalledWith(expect.anything(), { token: 't', maxRequests: 30 });
  });

  it('with nothing pending the drain is never called and no discussion count is reported', async () => {
    fetchWithReport.mockResolvedValue(listResult([full(1)]));
    const r = await fetchGitHubItems({ token: 't' });
    expect(drain).not.toHaveBeenCalled();
    expect('discussionPending' in r.report).toBe(false);
    expect('discussionTotal' in r.report).toBe(false);
  });

  it('all drained: total is reported and pending is zero (so the renderer prints no clause)', async () => {
    fetchWithReport.mockResolvedValue(listResult([thin(1)]));
    drain.mockResolvedValue({ items: [full(1)], skips: [], requests: 3 });
    const r = await fetchGitHubItems({ token: 't' });
    expect(r.report).toMatchObject({ discussionTotal: 1, discussionPending: 0 });
  });

  it('a drain that throws leaves every item thin and says so, and the import still happens', async () => {
    fetchWithReport.mockResolvedValue(listResult([thin(1), thin(2)]));
    drain.mockRejectedValue(new Error('socket hang up'));
    const r = await fetchGitHubItems({ token: 't' });
    expect(r.items).toEqual([thin(1), thin(2)]);
    expect(r.report).toMatchObject({ discussionTotal: 2, discussionPending: 2 });
    expect(r.report.skips.some((s) => s.kind === 'error' && /discussion/.test(s.detail))).toBe(true);
  });
});

describe('team scope is named in the report (review 5)', () => {
  it('names the repo when the SDK read team scope', async () => {
    fetchWithReport.mockResolvedValue({ items: [full(1)], report: { platform: 'github', scanned: 1, skips: [], complete: true, scope: 'team' } });
    const r = await fetchGitHubItems({ token: 't', repo: 'o/r', scope: 'team' });
    expect(r.report.scopeNote).toBe("everyone's PRs and issues in o/r, as far as your token can see");
  });

  it('says nothing when the SDK read only the caller\'s own items, even if team was asked for (no repo, so it falls back)', async () => {
    fetchWithReport.mockResolvedValue({ items: [full(1)], report: { platform: 'github', scanned: 1, skips: [], complete: true, scope: 'yours' } });
    const r = await fetchGitHubItems({ token: 't', scope: 'team' });
    expect('scopeNote' in r.report).toBe(false);
  });
});
