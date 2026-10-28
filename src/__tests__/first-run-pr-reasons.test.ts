/**
 * First run reads merged PR descriptions for a GitHub origin, because the
 * reason behind a change lives in the PR (squash-merge commits carry an empty body: measured null
 * "no stated reason" rate fastify 96.7%, vite 96.7%, pnpm 74.0%). Only the HTTP boundary is faked.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  dropCommitsOfStoredPrs, dropCoveredCommits, fetchFirstRunPrs, partialRateLimitLine, RATE_LIMIT_LINE,
} from '../lib/first-run-pr-import.js';
import { CLI_TOKEN_SOURCES, detectVerifiedCliToken } from '../lib/setup-ux.js';
import { verifyReadOnlyGithubToken } from '../lib/token-scope-gate.js';

const REPO = 'github.com/acme/widgets';
const BECAUSE = 'The router rebuilt its table on every request because the cache key ignored the prefix.';
const TEMPLATE = '## Checklist\n\n- [ ] I added tests because the old suite missed this\n- [x] I updated the docs so that users find it';

interface FakePr { number: number; title: string; body: string | null; merged_at: string | null; user?: { login: string; type?: string }; merge_commit_sha?: string }
function pr(n: number, over: Partial<FakePr> = {}): FakePr {
  return {
    number: n, title: `fix: thing ${n}`, body: BECAUSE, merged_at: `2026-03-${String((n % 27) + 1).padStart(2, '0')}T10:00:00Z`,
    user: { login: 'ada', type: 'User' }, merge_commit_sha: `${String(n).padStart(2, '0')}${'a'.repeat(38)}`, ...over,
  };
}
const row = (p: FakePr) => ({
  ...p, html_url: `https://github.com/acme/widgets/pull/${p.number}`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-03-30T00:00:00Z',
  base: { repo: { full_name: 'acme/widgets' } },
});

/** A GitHub that serves `pages` (arrays of PRs) in order and records every request. */
function fakeGitHub(pages: FakePr[][], opts: { status?: (page: number) => number; remaining?: string } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
    const u = String(url);
    calls.push({ url: u, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    const status = opts.status?.(page) ?? 200;
    return new Response(status === 200 ? JSON.stringify((pages[page - 1] ?? []).map(row)) : '{"message":"rate limited"}', {
      status, headers: { 'x-ratelimit-remaining': opts.remaining ?? '50' },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const none = async () => null;

describe('first-run PR descriptions', () => {
  it('imports a merged PR whose body states a reason, as a decision at the PR url', async () => {
    const gh = fakeGitHub([[pr(7, { title: 'fix: router cache' })]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(out.items).toHaveLength(1);
    const item = out.items[0]!;
    expect(item.source_url).toBe('https://github.com/acme/widgets/pull/7');
    expect(item.platform).toBe('github');
    expect(item.title).toBe('fix: router cache');
    expect(item.raw_text).toContain(BECAUSE);
    expect(item.raw_text).toContain('Status: merged');
    // decided_at is when it merged, not when it was opened
    expect(item.created_at).toBe('2026-03-08T10:00:00.000Z');
    expect(out.imported).toBe(1);
  });

  it('imports a second reason-stating PR too, at its own url', async () => {
    const gh = fakeGitHub([[pr(31, { title: 'feat: other', body: 'Use a Map so that lookups stay constant time.', merged_at: '2026-04-02T09:30:00Z' })]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(out.items.map((i) => i.source_url)).toEqual(['https://github.com/acme/widgets/pull/31']);
    expect(out.items[0]!.created_at).toBe('2026-04-02T09:30:00.000Z');
  });

  it('never imports a PR whose body is only a template checklist, nor an empty one', async () => {
    const gh = fakeGitHub([[pr(1, { body: TEMPLATE }), pr(2, { body: null }), pr(3, { body: '' }), pr(4)]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(out.items.map((i) => i.source_url)).toEqual(['https://github.com/acme/widgets/pull/4']);
    expect(out.scanned).toBe(4);
  });

  it('skips unmerged and bot PRs', async () => {
    const gh = fakeGitHub([[
      pr(1, { merged_at: null }),
      pr(2, { user: { login: 'dependabot[bot]', type: 'Bot' } }),
      pr(3, { user: { login: 'renovate-bot', type: 'Bot' } }),
      pr(4),
    ]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(out.items.map((i) => i.source_url)).toEqual(['https://github.com/acme/widgets/pull/4']);
  });

  it('does not import a release or version-bump PR, and counts it apart from "no reason" PRs', async () => {
    // fastify#6816 "Bumped v5.9.0" led the first-run sample box: its body (release notes) states a reason.
    const gh = fakeGitHub([[
      pr(6816, { title: 'Bumped v5.9.0' }),
      pr(6010, { title: 'build(deps): bump esbuild from 0.25.12 to 0.28.1' }),
      pr(7089, { title: 'fix: clamp error statusCode between 400 and 599 with 500 fallback' }),
      pr(5, { body: null }),
    ]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(out.items.map((i) => i.title)).toEqual(['fix: clamp error statusCode between 400 and 599 with 500 fallback']);
    expect(out.housekeeping).toBe(2);
    expect(out.scanned).toBe(4);
  });

  it('keeps the PR title as written even when it is a squash subject with (#N)', async () => {
    const gh = fakeGitHub([[pr(9, { title: 'fix: cache (#9)' })]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(out.items[0]!.title).toBe('fix: cache (#9)');
  });
});

describe('request shape and bounds', () => {
  it('unauthenticated: no Authorization header, at most 3 pages, stops at 300 merged PRs', async () => {
    const full = (from: number) => Array.from({ length: 100 }, (_, i) => pr(from + i));
    const gh = fakeGitHub([full(1), full(101), full(201), full(301)]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(gh.calls).toHaveLength(3);
    expect(gh.calls.every((c) => !Object.keys(c.headers).some((h) => h.toLowerCase() === 'authorization'))).toBe(true);
    expect(gh.calls[0]!.url).toContain('/repos/acme/widgets/pulls?state=closed');
    expect(out.scanned).toBe(300);
  });

  it('unauthenticated: three pages is the bound even when most rows are unmerged', async () => {
    const half = (from: number) => Array.from({ length: 100 }, (_, i) => pr(from + i, i % 2 ? { merged_at: null } : {}));
    const gh = fakeGitHub([half(1), half(101), half(201), half(301), half(401)]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(gh.calls).toHaveLength(3);
    expect(out.scanned).toBe(150);
  });

  it('stops after a short page without asking for another', async () => {
    const gh = fakeGitHub([[pr(1), pr(2)]]);
    await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(gh.calls).toHaveLength(1);
  });

  it('stops paging when GitHub says no requests remain, and says nothing about it', async () => {
    const full = (from: number) => Array.from({ length: 100 }, (_, i) => pr(from + i));
    const gh = fakeGitHub([full(1), full(101)], { remaining: '0' });
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(gh.calls).toHaveLength(1);
    expect(out.imported).toBe(100);
    expect(out.note).toBeUndefined();
  });

  it('with a read-only token: sends it, reads up to 1,000 PRs', async () => {
    const full = (from: number) => Array.from({ length: 100 }, (_, i) => pr(from + i));
    const gh = fakeGitHub(Array.from({ length: 12 }, (_, i) => full(1 + i * 100)));
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: async () => ({ token: 'ghp_readonly' }) });
    expect(gh.calls[0]!.headers['Authorization']).toBe('Bearer ghp_readonly');
    expect(out.scanned).toBe(1000);
    expect(gh.calls.length).toBeLessThanOrEqual(12);
  });
});

describe('token safety', () => {
  const source = (scopes: string, onVerify: () => void = () => undefined) => ({
    bin: process.execPath, args: ['-e', 'console.log("ghp_fromgh")'], label: 'gh',
    verify: (t: string) => verifyReadOnlyGithubToken(t, (async () => { onVerify(); return new Response('{}', { status: 200, headers: { 'x-oauth-scopes': scopes } }); }) as unknown as typeof fetch),
  });

  it('a write-capable gh token (repo scope) is never sent to GitHub', async () => {
    const gh = fakeGitHub([[pr(1)]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: () => detectVerifiedCliToken(source('repo, read:org')) });
    expect(gh.calls).toHaveLength(1);
    expect(JSON.stringify(gh.calls.map((c) => c.headers))).not.toContain('ghp_fromgh');
    expect(Object.keys(gh.calls[0]!.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(out.imported).toBe(1);
  });

  it('a fine-grained token (no scope list, cannot be proven read-only) is not sent either', async () => {
    const gh = fakeGitHub([[pr(1)]]);
    const none2 = { ...source(''), verify: (t: string) => verifyReadOnlyGithubToken(t, (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch) };
    await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: () => detectVerifiedCliToken(none2) });
    expect(JSON.stringify(gh.calls.map((c) => c.headers))).not.toContain('ghp_fromgh');
  });

  it('a token proven read-only by the existing gate is used', async () => {
    const gh = fakeGitHub([[pr(1)]]);
    await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: () => detectVerifiedCliToken(source('read:org')) });
    expect(gh.calls[0]!.headers['Authorization']).toBe('Bearer ghp_fromgh');
  });

  it('the default token source is the existing gh gate, not a new one', () => {
    expect(CLI_TOKEN_SOURCES['github']?.bin).toBe('gh');
  });
});

describe('degrading', () => {
  it.each([[403, '0'], [429, '50']])('HTTP %i on the first page: no PRs, and the exact one-line explanation', async (status, remaining) => {
    const gh = fakeGitHub([[pr(1)]], { status: () => status, remaining });
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(out.items).toEqual([]);
    expect(out.note).toBe('GitHub rate limit reached, imported commits only; run `align connect github` for PR descriptions');
    expect(out.note).toBe(RATE_LIMIT_LINE);
    expect(gh.calls).toHaveLength(1);
  });

  it('a limit hit on page 2 keeps page 1 and says how many PR descriptions it did import', async () => {
    const full = Array.from({ length: 100 }, (_, i) => pr(1 + i));
    const fetchFn = vi.fn(async (u: string | URL | Request) => {
      const page = Number(new URL(String(u)).searchParams.get('page'));
      return page === 2 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify(full.map(row)), { status: 200, headers: { 'x-ratelimit-remaining': '9' } });
    }) as unknown as typeof fetch;
    const out = await fetchFirstRunPrs(REPO, { fetchFn, detectToken: none });
    expect(out.imported).toBe(100);
    expect(out.note).toBe(partialRateLimitLine(100));
    expect(out.note).toContain('100 PR descriptions');
  });

  it('a 403 that is not about quota (a blocked repo) is silent, not a rate-limit line', async () => {
    const gh = fakeGitHub([[pr(1)]], { status: () => 403, remaining: '50' });
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(out.items).toEqual([]);
    expect(out.note).toBeUndefined();
  });

  it('a 403 that says when to retry is a rate limit even with quota shown', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 403, headers: { 'retry-after': '60' } })) as unknown as typeof fetch;
    expect((await fetchFirstRunPrs(REPO, { fetchFn, detectToken: none })).note).toBe(RATE_LIMIT_LINE);
  });

  it('a private repo with no token (404) is silent', async () => {
    const gh = fakeGitHub([[pr(1)]], { status: () => 404 });
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(out.items).toEqual([]);
    expect(out.note).toBeUndefined();
  });

  it.each(['acme/..', '../widgets', './widgets'])('refuses a dot-segment repo path %s', async (name) => {
    const gh = fakeGitHub([[pr(1)]]);
    await fetchFirstRunPrs(`github.com/${name}`, { fetchFn: gh.fetchFn, detectToken: none });
    expect(gh.calls).toHaveLength(0);
  });

  it('a network failure never throws', async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(fetchFirstRunPrs(REPO, { fetchFn, detectToken: none })).resolves.toMatchObject({ items: [], imported: 0 });
  });

  it('a hung GitHub is cut off at the deadline', async () => {
    const fetchFn = vi.fn((_u: unknown, init?: Parameters<typeof fetch>[1]) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const t = Date.now();
    const out = await fetchFirstRunPrs(REPO, { fetchFn, detectToken: none, deadlineMs: 60 });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(out.items).toEqual([]);
    // the request itself is cancelled, not left running behind first run
    expect((fetchFn as unknown as { mock: { calls: Array<[unknown, NonNullable<Parameters<typeof fetch>[1]>]> } }).mock.calls[0]![1].signal?.aborted).toBe(true);
  });

  it('a token lookup that throws is treated as no token', async () => {
    const gh = fakeGitHub([[pr(1)]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: async () => { throw new Error('boom'); } });
    expect(out.imported).toBe(1);
  });
});

describe('origins that are not GitHub', () => {
  it.each([null, undefined, 'gitlab.com/acme/widgets', '/home/me/repo', 'github.example.com/acme/widgets', 'notgithub.com/acme/widgets'])('%s makes no request and no token lookup', async (identity) => {
    const gh = fakeGitHub([[pr(1)]]);
    const detectToken = vi.fn(none);
    const out = await fetchFirstRunPrs(identity, { fetchFn: gh.fetchFn, detectToken });
    expect(gh.calls).toHaveLength(0);
    expect(detectToken).not.toHaveBeenCalled();
    expect(out).toMatchObject({ items: [], imported: 0 });
    expect(out.note).toBeUndefined();
  });
});

describe('a squash commit and its PR appear once', () => {
  const commit = (sha: string, title: string) => ({ source_url: `https://github.com/acme/widgets/commit/${sha}`, platform: 'git', raw_text: title, title });
  const sha7 = `07${'a'.repeat(38)}`;

  it('drops the commit that IS the imported PR merge commit, whatever its subject says', async () => {
    const gh = fakeGitHub([[pr(7)]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    const kept = dropCoveredCommits([commit(sha7, 'fix: thing 7 (#7)'), commit(`12${'b'.repeat(38)}`, 'something else')], out);
    expect(kept.items.map((c) => c.title)).toEqual(['something else']);
    expect(kept.covered).toBe(1);
    const reworded = dropCoveredCommits([commit(sha7, 'Reworded subject with no number')], out);
    expect(reworded.covered).toBe(1);
  });

  it('keeps a commit that only CLAIMS the number (an upstream commit in a fork)', async () => {
    const gh = fakeGitHub([[pr(7)]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(dropCoveredCommits([commit('b'.repeat(40), 'fix: thing 7 (#7)')], out)).toMatchObject({ covered: 0 });
  });

  it('a PR that was not imported (no stated reason) does not cover its commit', async () => {
    const gh = fakeGitHub([[pr(7, { body: TEMPLATE })]]);
    const out = await fetchFirstRunPrs(REPO, { fetchFn: gh.fetchFn, detectToken: none });
    expect(dropCoveredCommits([commit(sha7, 'fix: thing 7 (#7)')], out).covered).toBe(0);
  });

  it('with no PRs at all the commits come back as the same array', async () => {
    const out = await fetchFirstRunPrs(null);
    const commits = [commit('a'.repeat(40), 'x (#1)')];
    expect(dropCoveredCommits(commits, out)).toEqual({ items: commits, covered: 0 });
  });
});

describe('a later `align connect git` does not bring the squash commit back', () => {
  const c = (subject: string) => ({ subject });
  const urls = ['https://github.com/acme/widgets/pull/7', 'https://github.com/acme/widgets/pull/9', 'https://github.com/acme/gadgets/pull/12'];
  it('drops commits whose (#N) is a stored PR of this repo, and only those', () => {
    const out = dropCommitsOfStoredPrs([c('fix a (#7)'), c('fix b (#9)'), c('fix c (#8)'), c('fix d (#12)'), c('no number')], urls, 'Acme/Widgets');
    expect(out.items.map((x) => x.subject)).toEqual(['fix c (#8)', 'fix d (#12)', 'no number']);
    expect(out.covered).toBe(2);
  });
  it('with no stored PRs of this repo, returns the same array', () => {
    const commits = [c('fix a (#7)')];
    expect(dropCommitsOfStoredPrs(commits, ['https://github.com/other/repo/pull/7'], 'acme/widgets')).toEqual({ items: commits, covered: 0 });
  });
});
