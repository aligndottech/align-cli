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
  vi.useRealTimers();
});

/** A drain that behaves like the SDK's: newest first, 3 requests per PR, stops before the budget. */
function sdkDrain(opts: { fail?: (call: number) => boolean; tick?: () => void } = {}) {
  let call = 0;
  return async (items: Array<ReturnType<typeof thin>>, o: { maxRequests: number }) => {
    call++;
    opts.tick?.();
    if (opts.fail?.(call)) return { items: [], skips: [{ kind: 'error', count: items.length, detail: 'items whose discussion GitHub failed to return; they stay pending' }], requests: 1 };
    const out: unknown[] = [];
    let requests = 0;
    for (const it of items) {
      if (requests + 3 > o.maxRequests) break;
      requests += 3;
      out.push({ ...it, raw_text: `${it.raw_text}\n\n## Comments\nx`, detail_pending: false });
    }
    return { items: out, skips: out.length < items.length ? [{ kind: 'page_cap', count: items.length - out.length, detail: 'sdk budget line' }] : [], requests };
  };
}
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...thin(i + 1), updated_at: `2026-09-${String(30 - (i % 28)).padStart(2, '0')}T00:00:00Z` }));

describe('items first, then a budgeted discussion pass', () => {
  it('reads the list with discussion: none whatever the caller passed', async () => {
    fetchWithReport.mockResolvedValue(listResult([thin(1)]));
    drain.mockImplementation(sdkDrain());
    await fetchGitHubItems({ token: 'tok', limit: 3000, discussion: 'full' as never });
    expect(fetchWithReport.mock.calls[0]![0]).toMatchObject({ discussion: 'none', token: 'tok' });
    expect(GITHUB_DISCUSSION_BUDGET).toBe(600);
  });

  it('drains in chunks: ONE item first as a probe, then ten at a time, with the budget that is left', async () => {
    fetchWithReport.mockResolvedValue(listResult(many(25)));
    drain.mockImplementation(sdkDrain());
    const r = await fetchGitHubItems({ token: 't' });
    const sizes = drain.mock.calls.map((c) => (c[0] as unknown[]).length);
    expect(sizes).toEqual([1, 10, 10, 4]);
    const budgets = drain.mock.calls.map((c) => (c[1] as { maxRequests: number }).maxRequests);
    expect(budgets).toEqual([600, 597, 567, 537]);
    expect(r.report).toMatchObject({ discussionTotal: 25, discussionPending: 0 });
    expect(r.items.every((i) => i.detail_pending === false)).toBe(true);
  });

  it('newest first across chunks (the SDK only orders within the items it is given)', async () => {
    const items = [
      { ...thin(1), updated_at: '2026-01-01T00:00:00Z' },
      { ...thin(2), updated_at: '2026-09-01T00:00:00Z' },
      { ...thin(3), updated_at: '2026-05-01T00:00:00Z' },
    ];
    fetchWithReport.mockResolvedValue(listResult(items));
    drain.mockImplementation(sdkDrain());
    await fetchGitHubItems({ token: 't' });
    expect(drain.mock.calls.flatMap((c) => (c[0] as typeof items).map((i) => i.source_url))).toEqual([items[1]!.source_url, items[2]!.source_url, items[0]!.source_url]);
  });

  it('returns the items in their ORIGINAL order, enriched where the drain reached them', async () => {
    fetchWithReport.mockResolvedValue(listResult([thin(1), thin(2), thin(3)]));
    drain.mockImplementation(sdkDrain());
    const r = await fetchGitHubItems({ token: 't', discussionBudget: 6 }); // room for two PRs
    expect(r.items.map((i) => i.source_url)).toEqual([thin(1), thin(2), thin(3)].map((i) => i.source_url));
    expect(r.items.filter((i) => i.detail_pending === true)).toHaveLength(1);
    expect(r.report).toMatchObject({ discussionTotal: 3, discussionPending: 1 });
  });

  it('the request budget ends the pass and is reported once, in our words', async () => {
    fetchWithReport.mockResolvedValue(listResult(many(25)));
    drain.mockImplementation(sdkDrain());
    const r = await fetchGitHubItems({ token: 't', discussionBudget: 30 }); // ten PRs
    expect(r.report).toMatchObject({ discussionTotal: 25, discussionPending: 15 });
    const budgetSkips = r.report.skips.filter((k) => k.kind === 'page_cap');
    expect(budgetSkips).toEqual([{ kind: 'page_cap', count: 15, detail: 'items whose discussion was not read: the request budget of 30 ran out' }]);
    expect(JSON.stringify(r.report.skips)).not.toContain('sdk budget line');
  });

  it('a REVOKED token costs about one request, not the budget: the probe is refused, the pass stops, every item stays thin', async () => {
    fetchWithReport.mockResolvedValue(listResult(many(25)));
    drain.mockImplementation(sdkDrain({ fail: () => true }));
    const r = await fetchGitHubItems({ token: 'revoked' });
    expect(drain).toHaveBeenCalledTimes(1);
    expect((drain.mock.calls[0]![0] as unknown[]).length).toBe(1);
    expect(r.report).toMatchObject({ discussionTotal: 25, discussionPending: 25 });
    expect(r.report.skips.some((k) => k.kind === 'error' && /refused or rate-limited/.test(k.detail) && /24 items stay thin|25 items stay thin/.test(k.detail))).toBe(true);
  });

  it('a refusal in the middle stops the pass there (rate limit hit after some success)', async () => {
    fetchWithReport.mockResolvedValue(listResult(many(25)));
    drain.mockImplementation(sdkDrain({ fail: (call) => call >= 3 }));
    const r = await fetchGitHubItems({ token: 't' });
    expect(drain).toHaveBeenCalledTimes(3);
    expect(r.report).toMatchObject({ discussionTotal: 25, discussionPending: 14 }); // 1 + 10 got it
  });

  it('a deadline ends the pass between chunks: what is left of the time budget after the list fetch, at least 30 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    fetchWithReport.mockResolvedValue(listResult(many(25)));
    drain.mockImplementation(sdkDrain({ tick: () => vi.setSystemTime(Date.now() + 40_000) })); // each chunk "takes" 40 s
    const r = await fetchGitHubItems({ token: 't', timeBudgetMs: 60_000 });
    expect(drain).toHaveBeenCalledTimes(2); // 0 s, 40 s: start the second; at 80 s the 60 s is spent
    expect(r.report.skips.some((k) => k.kind === 'time_budget' && /time budget/.test(k.detail))).toBe(true);
    expect(r.report.discussionPending).toBeGreaterThan(0);
  });

  it('the deadline is never shorter than 30 s, even if the list fetch used the whole budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    fetchWithReport.mockImplementation(async () => { vi.setSystemTime(Date.now() + 100_000); return listResult(many(5)); });
    drain.mockImplementation(sdkDrain());
    const r = await fetchGitHubItems({ token: 't', timeBudgetMs: 60_000 });
    expect(drain).toHaveBeenCalled();
    expect(r.report.discussionPending).toBe(0);
  });

  it('with nothing pending the drain is never called and no discussion count is reported', async () => {
    fetchWithReport.mockResolvedValue(listResult([full(1)]));
    const r = await fetchGitHubItems({ token: 't' });
    expect(drain).not.toHaveBeenCalled();
    expect('discussionPending' in r.report).toBe(false);
    expect('discussionTotal' in r.report).toBe(false);
  });

  it('a drain that throws leaves every item thin and says so, and the import still happens', async () => {
    fetchWithReport.mockResolvedValue(listResult([thin(1), thin(2)]));
    drain.mockRejectedValue(new Error('socket hang up'));
    const r = await fetchGitHubItems({ token: 't' });
    expect(r.items).toEqual([thin(1), thin(2)]);
    expect(r.report).toMatchObject({ discussionTotal: 2, discussionPending: 2 });
    expect(r.report.skips.some((k) => k.kind === 'error' && /discussion/.test(k.detail))).toBe(true);
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
