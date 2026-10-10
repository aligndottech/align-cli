import { describe, expect, it, vi } from 'vitest';
import {
  findConfluenceSpace, findJiraProject, findLinearTeam, githubRepoVisibility, gitlabProjectVisibility, listConfluenceSpaces, listJiraProjects, listLinearTeams, ScopeLookupError,
} from '../lib/scope-choices.js';

/**
 * L4 Test List (looking up what a token can see, to pick or check a scope):
 * - Each lookup uses the SAVED token inside this process, sends it only to the vendor's own host, never follows a redirect with it,
 *   and returns names and keys only.
 * - The host comes from the connector's stored fields and is checked to be a hostname before anything is sent: a stored or
 *   supplied "evil.com/x" or "a.com@evil.com" makes no request.
 * - Jira and Confluence page through their lists; a refused token and an unreachable vendor are different errors, and neither
 *   message carries the token or the response body.
 * - GitHub repo visibility: 200 visible, 422 "cannot be searched" invisible (P0), anything else "unknown", never a guess.
 * - GitLab project visibility: 200 visible, 404 invisible, anything else unknown.
 */
type Init = NonNullable<Parameters<typeof fetch>[1]>;
type Call = { url: string; init: Init };
const TOKEN = 'SECRET-TOKEN-0123456789';
const jiraFields = { token: TOKEN, email: 'me@acme.com', domain: 'acme.atlassian.net' };

function scripted(responses: Array<{ status?: number; body?: unknown } | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const f = vi.fn(async (url: string | URL | Request, init?: Init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

describe('listJiraProjects', () => {
  it('reads project keys and names with basic auth from the saved fields, to the saved site only, without following redirects', async () => {
    const s = scripted([{ body: { values: [{ key: 'ALI', name: 'Align' }, { key: 'OPS', name: 'Ops' }], isLast: true } }]);
    const r = await listJiraProjects(jiraFields, s.fetch);
    expect(r).toEqual({ items: [{ key: 'ALI', name: 'Align' }, { key: 'OPS', name: 'Ops' }], truncated: false });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url.startsWith('https://acme.atlassian.net/rest/api/3/project/search?')).toBe(true);
    expect((s.calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${Buffer.from(`me@acme.com:${TOKEN}`).toString('base64')}`);
    expect(s.calls[0]!.init.redirect).toBe('manual');
  });

  it('pages until the vendor says the last page (two pages, then one)', async () => {
    const s = scripted([
      { body: { values: [{ key: 'AAA', name: 'a' }], isLast: false, startAt: 0, maxResults: 1 } },
      { body: { values: [{ key: 'BBB', name: 'b' }], isLast: true, startAt: 1, maxResults: 1 } },
    ]);
    expect((await listJiraProjects(jiraFields, s.fetch)).items.map((p) => p.key)).toEqual(['AAA', 'BBB']);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.url).toContain('startAt=1');
  });

  it('a hostile or malformed stored domain makes no request (three shapes)', async () => {
    for (const domain of ['evil.com/x', 'a.com@evil.com', 'evil.com:8080', '', 'no_dots']) {
      const s = scripted([{ body: { values: [], isLast: true } }]);
      await expect(listJiraProjects({ ...jiraFields, domain }, s.fetch), domain).rejects.toBeInstanceOf(ScopeLookupError);
      expect(s.calls, domain).toHaveLength(0);
    }
  });

  it('a missing email or token is an error that makes no request', async () => {
    const s = scripted([{}]);
    await expect(listJiraProjects({ token: TOKEN, domain: 'acme.atlassian.net' }, s.fetch)).rejects.toBeInstanceOf(ScopeLookupError);
    expect(s.calls).toHaveLength(0);
  });

  it('401 is "refused the saved token"; 500 and a network failure are "could not reach"; none carries the token or the body', async () => {
    for (const [resp, kind] of [[{ status: 401, body: { message: `bad ${TOKEN}` } }, 'auth'], [{ status: 403, body: {} }, 'auth'], [{ status: 500, body: { message: TOKEN } }, 'unreachable'], [new Error(`connect ECONNREFUSED ${TOKEN}`), 'unreachable']] as const) {
      const s = scripted([resp]);
      let err: ScopeLookupError | undefined;
      try { await listJiraProjects(jiraFields, s.fetch); } catch (e) { err = e as ScopeLookupError; }
      expect(err).toBeInstanceOf(ScopeLookupError);
      expect(err!.kind).toBe(kind);
      expect(err!.message).not.toContain(TOKEN);
    }
  });
});

describe('listConfluenceSpaces', () => {
  it('reads space keys and names from the v2 API and follows the cursor on the same site only', async () => {
    const s = scripted([
      { body: { results: [{ key: 'ENG', name: 'Engineering' }], _links: { next: '/wiki/api/v2/spaces?cursor=abc&limit=250' } } },
      { body: { results: [{ key: 'OPS', name: 'Ops' }], _links: {} } },
    ]);
    const r = await listConfluenceSpaces(jiraFields, s.fetch);
    expect(r.items).toEqual([{ key: 'ENG', name: 'Engineering' }, { key: 'OPS', name: 'Ops' }]);
    expect(s.calls[0]!.url.startsWith('https://acme.atlassian.net/wiki/api/v2/spaces?limit=250')).toBe(true);
    expect(s.calls[1]!.url).toBe('https://acme.atlassian.net/wiki/api/v2/spaces?cursor=abc&limit=250');
  });

  it('an absolute next link to another host is not followed with the credential', async () => {
    const s = scripted([{ body: { results: [{ key: 'ENG', name: 'E' }], _links: { next: 'https://evil.example/steal' } } }]);
    const r = await listConfluenceSpaces(jiraFields, s.fetch);
    expect(r.items.map((x) => x.key)).toEqual(['ENG']);
    expect(s.calls).toHaveLength(1);
  });

  it('a hostile stored domain makes no request', async () => {
    const s = scripted([{}]);
    await expect(listConfluenceSpaces({ ...jiraFields, domain: 'x.com/../y' }, s.fetch)).rejects.toBeInstanceOf(ScopeLookupError);
    expect(s.calls).toHaveLength(0);
  });
});

describe('listLinearTeams', () => {
  it('asks the GraphQL endpoint for team ids and keys; an API key goes bare, an OAuth token as Bearer (two examples)', async () => {
    const body = { data: { teams: { nodes: [{ id: 'id-1', key: 'ENG', name: 'Engineering' }] } } };
    const a = scripted([{ body }]);
    expect((await listLinearTeams({ token: 'lin_api_abc' }, a.fetch)).items).toEqual([{ id: 'id-1', key: 'ENG', name: 'Engineering' }]);
    expect(a.calls[0]!.url).toBe('https://api.linear.app/graphql');
    expect((a.calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('lin_api_abc');
    const b = scripted([{ body }]);
    await listLinearTeams({ token: 'lin_oauth_abc' }, b.fetch);
    expect((b.calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer lin_oauth_abc');
  });

  it('a GraphQL error body or a 401 is an error without the token', async () => {
    const s = scripted([{ status: 401, body: {} }]);
    await expect(listLinearTeams({ token: 'lin_api_abc' }, s.fetch)).rejects.toMatchObject({ kind: 'auth' });
    const t = scripted([{ body: { errors: [{ message: 'nope lin_api_abc' }] } }]);
    const err = await listLinearTeams({ token: 'lin_api_abc' }, t.fetch).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ScopeLookupError);
    expect((err as Error).message).not.toContain('lin_api_abc');
  });
});

describe('githubRepoVisibility', () => {
  const probe = async (r: { status?: number } | Error) => {
    const s = scripted([r]);
    return { v: await githubRepoVisibility(TOKEN, 'o/r', s.fetch), calls: s.calls };
  };

  it('200 means visible; 422 "cannot be searched" means invisible (two examples each side)', async () => {
    expect((await probe({ status: 200 })).v).toBe('visible');
    expect((await probe({ status: 422 })).v).toBe('invisible');
  });

  it('401, 403, 500 and a network failure are unknown, never invisible', async () => {
    for (const r of [{ status: 401 }, { status: 403 }, { status: 500 }, new Error('offline')]) {
      expect((await probe(r)).v).toBe('unknown');
    }
  });

  it('sends the search for exactly that repo, to api.github.com, with the token and no redirect', async () => {
    const { calls } = await probe({ status: 200 });
    expect(calls[0]!.url).toBe('https://api.github.com/search/issues?q=repo%3Ao%2Fr&per_page=1');
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('refuses a repo that is not owner/repo without a request', async () => {
    const s = scripted([{ status: 200 }]);
    expect(await githubRepoVisibility(TOKEN, 'o/r&per_page=100', s.fetch)).toBe('unknown');
    expect(s.calls).toHaveLength(0);
  });
});

describe('gitlabProjectVisibility', () => {
  it('200 visible, 404 invisible, anything else unknown; the project is one encoded path segment', async () => {
    const a = scripted([{ status: 200 }]);
    expect(await gitlabProjectVisibility({ token: TOKEN }, 'group/sub/p', a.fetch)).toBe('visible');
    expect(a.calls[0]!.url).toBe('https://gitlab.com/api/v4/projects/group%2Fsub%2Fp');
    expect((a.calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(await gitlabProjectVisibility({ token: TOKEN }, '12', scripted([{ status: 404 }]).fetch)).toBe('invisible');
    expect(await gitlabProjectVisibility({ token: TOKEN }, '12', scripted([{ status: 500 }]).fetch)).toBe('unknown');
  });

  it('uses the stored self-managed domain, and a hostile domain makes no request', async () => {
    const a = scripted([{ status: 200 }]);
    await gitlabProjectVisibility({ token: TOKEN, domain: 'git.acme.io' }, '12', a.fetch);
    expect(a.calls[0]!.url.startsWith('https://git.acme.io/api/v4/projects/12')).toBe(true);
    const b = scripted([{ status: 200 }]);
    expect(await gitlabProjectVisibility({ token: TOKEN, domain: 'evil.com/x' }, '12', b.fetch)).toBe('unknown');
    expect(b.calls).toHaveLength(0);
  });
});

describe('truncated lists and direct lookup of a named key', () => {
  it('a list cut at the cap says so (Jira, Confluence, Linear)', async () => {
    const jira = scripted([{ body: { values: [{ key: 'AAA', name: 'a' }, { key: 'BBB', name: 'b' }], isLast: false, startAt: 0, maxResults: 2 } }]);
    expect(await listJiraProjects(jiraFields, jira.fetch, { max: 2 })).toMatchObject({ truncated: true });
    expect(jira.calls).toHaveLength(1);
    const conf = scripted([{ body: { results: [{ key: 'A', name: 'a' }, { key: 'B', name: 'b' }], _links: { next: '/wiki/api/v2/spaces?cursor=x' } } }]);
    expect(await listConfluenceSpaces(jiraFields, conf.fetch, { max: 2 })).toMatchObject({ truncated: true });
    const lin = scripted([{ body: { data: { teams: { nodes: [{ id: 'i', key: 'ENG', name: 'E' }], pageInfo: { hasNextPage: true } } } } }]);
    expect(await listLinearTeams({ token: 'lin_api_abc' }, lin.fetch)).toMatchObject({ truncated: true });
  });

  it('a list that reached its end is not truncated, even at exactly the cap', async () => {
    const jira = scripted([{ body: { values: [{ key: 'AAA', name: 'a' }, { key: 'BBB', name: 'b' }], isLast: true } }]);
    expect(await listJiraProjects(jiraFields, jira.fetch, { max: 2 })).toMatchObject({ truncated: false });
  });

  it('findJiraProject asks for exactly that key on the saved site: 200 found, 404 not found, 401 is a refusal (three outcomes)', async () => {
    const ok = scripted([{ body: { key: 'ALI', name: 'Align' } }]);
    expect(await findJiraProject(jiraFields, 'ALI', ok.fetch)).toBe(true);
    expect(ok.calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/project/ALI');
    expect(await findJiraProject(jiraFields, 'ALI', scripted([{ status: 404 }]).fetch)).toBe(false);
    await expect(findJiraProject(jiraFields, 'ALI', scripted([{ status: 401 }]).fetch)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('findConfluenceSpace asks for that key only and is true only when it comes back', async () => {
    const hit = scripted([{ body: { results: [{ key: 'ENG', name: 'E' }] } }]);
    expect(await findConfluenceSpace(jiraFields, 'ENG', hit.fetch)).toBe(true);
    expect(hit.calls[0]!.url).toBe('https://acme.atlassian.net/wiki/api/v2/spaces?keys=ENG&limit=1');
    expect(await findConfluenceSpace(jiraFields, 'ENG', scripted([{ body: { results: [] } }]).fetch)).toBe(false);
  });

  it('findLinearTeam filters on that key and returns its id, or undefined', async () => {
    const hit = scripted([{ body: { data: { teams: { nodes: [{ id: 'id-9', key: 'ENG', name: 'E' }] } } } }]);
    expect(await findLinearTeam({ token: 'lin_api_abc' }, 'ENG', hit.fetch)).toEqual({ id: 'id-9', key: 'ENG', name: 'E' });
    expect(JSON.parse(String(hit.calls[0]!.init.body))).toMatchObject({ variables: { key: 'ENG' } });
    expect(String(hit.calls[0]!.init.body)).not.toMatch(/eq: "ENG"/);
    expect(await findLinearTeam({ token: 'lin_api_abc' }, 'ENG', scripted([{ body: { data: { teams: { nodes: [] } } } }]).fetch)).toBeUndefined();
  });

  it('a hostile stored domain makes no direct lookup request either', async () => {
    const s = scripted([{}]);
    await expect(findJiraProject({ ...jiraFields, domain: 'evil.com/x' }, 'ALI', s.fetch)).rejects.toBeInstanceOf(ScopeLookupError);
    expect(s.calls).toHaveLength(0);
  });
});

describe('limits on what a vendor can make this process read', () => {
  it('Confluence paging stops at 50 pages and says the list is truncated', async () => {
    const page = { body: { results: [{ key: 'A', name: 'a' }], _links: { next: '/wiki/api/v2/spaces?cursor=again' } } };
    const s = scripted([page]);
    const r = await listConfluenceSpaces(jiraFields, s.fetch);
    expect(s.calls).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it('a response body over 2 MB is refused as unreadable, not read into memory (Jira, Linear)', async () => {
    const huge = 'x'.repeat(2_100_000);
    const s = scripted([{ body: { values: [{ key: 'ALI', name: huge }], isLast: true } }]);
    await expect(listJiraProjects(jiraFields, s.fetch)).rejects.toMatchObject({ kind: 'unreachable' });
    const l = scripted([{ body: { data: { teams: { nodes: [{ id: 'i', key: 'ENG', name: huge }] } } } }]);
    await expect(listLinearTeams({ token: 'lin_api_abc' }, l.fetch)).rejects.toBeInstanceOf(ScopeLookupError);
  });

  it('a body just under the cap is read', async () => {
    const ok = scripted([{ body: { values: [{ key: 'ALI', name: 'x'.repeat(1_900_000) }], isLast: true } }]);
    expect((await listJiraProjects(jiraFields, ok.fetch)).items).toHaveLength(1);
  });

  it('a repo with a dots-only segment is not probed', async () => {
    const s = scripted([{ status: 200 }]);
    expect(await githubRepoVisibility(TOKEN, 'o/..', s.fetch)).toBe('unknown');
    expect(s.calls).toHaveLength(0);
  });
});
