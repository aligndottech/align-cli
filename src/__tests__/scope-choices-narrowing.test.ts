import { describe, expect, it } from 'vitest';
import { checkJiraJql, jiraBoardFilterJql, listJiraBoards, listLinearProjects, proveToken, ScopeLookupError } from '../lib/scope-choices.js';
import { routes } from './helpers/scope-deps.js';

/**
 * What a token can see INSIDE a project or team, so a person can narrow to their own part.
 * Jira boards: GET /rest/agile/1.0/board?projectKeyOrId=KEY (startAt/maxResults/isLast), and a board's filter via
 * /board/{id}/configuration then /rest/api/3/filter/{id} (https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/).
 *
 * Test List:
 * - The boards of one project, by id and name, read page by page (two examples).
 * - A site without Jira Software answers 404 for boards: that is "no boards", not an error.
 * - A board's filter JQL, through its configuration; a filter id that is not digits never reaches a URL.
 * - A JQL check: one search inside the project, 200 ok, 400 invalid, and the search narrows by the fragment.
 * - A Linear team's projects; the team id travels as a GraphQL variable, never spliced into the query.
 */

const JIRA = { email: 'e@x.dev', token: 't', domain: 'acme.atlassian.net' };

describe('Jira boards of one project', () => {
  it('lists boards by id and name, for the project asked', async () => {
    const r = routes([[/\/rest\/agile\/1\.0\/board\?projectKeyOrId=AC/, { body: { isLast: true, values: [{ id: 42, name: 'Payments' }, { id: 43, name: 'Payouts' }] } }]]);
    expect((await listJiraBoards(JIRA, 'AC', r.fetch)).items).toEqual([{ id: '42', name: 'Payments' }, { id: '43', name: 'Payouts' }]);
    expect(r.calls[0]).toContain('https://acme.atlassian.net/rest/agile/1.0/board?projectKeyOrId=AC');
  });

  it('reads the next page until isLast', async () => {
    let n = 0;
    const r = routes([[/\/board\?projectKeyOrId=AC/, { body: {} }]]);
    const f = (async (url: string) => {
      r.calls.push(String(url));
      const body = n++ === 0 ? { isLast: false, values: [{ id: 1, name: 'A' }] } : { isLast: true, values: [{ id: 2, name: 'B' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await listJiraBoards(JIRA, 'AC', f)).items.map((b) => b.name)).toEqual(['A', 'B']);
    expect(r.calls[1]).toContain('startAt=1');
  });

  it('a site without Jira Software (404) has no boards, and that is not an error', async () => {
    const r = routes([]);
    expect(await listJiraBoards(JIRA, 'AC', r.fetch)).toEqual({ items: [], truncated: false });
  });
});

describe("a Jira board's filter", () => {
  it('is read through the board configuration', async () => {
    const r = routes([
      [/\/rest\/agile\/1\.0\/board\/42\/configuration/, { body: { filter: { id: '10001' } } }],
      [/\/rest\/api\/3\/filter\/10001/, { body: { jql: 'project = AC AND team = 7 ORDER BY Rank ASC' } }],
    ]);
    expect(await jiraBoardFilterJql(JIRA, '42', r.fetch)).toBe('project = AC AND team = 7 ORDER BY Rank ASC');
  });

  it('a filter id that is not digits never reaches a URL', async () => {
    const r = routes([[/\/configuration/, { body: { filter: { id: '1/../../x' } } }]]);
    await expect(jiraBoardFilterJql(JIRA, '42', r.fetch)).rejects.toBeInstanceOf(ScopeLookupError);
    expect(r.calls.filter((c) => c.includes('/filter/'))).toEqual([]);
  });
});

describe('checking a JQL fragment inside a project', () => {
  const searchFetch = (status: number) => {
    const bodies: Array<Record<string, unknown>> = [];
    const f = (async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
    return { f, bodies };
  };

  it('Jira accepts it: ok, and the search was narrowed by it inside the project', async () => {
    const s = searchFetch(200);
    expect(await checkJiraJql(JIRA, ['AC'], 'labels = payments', s.f)).toBe('ok');
    expect(s.bodies[0]!['jql']).toBe('project in (AC) AND (labels = payments) ORDER BY updated DESC');
    expect(s.bodies[0]!['maxResults']).toBe(1);
  });

  it('Jira refuses it: invalid', async () => {
    expect(await checkJiraJql(JIRA, ['AC'], 'labelz = payments', searchFetch(400).f)).toBe('invalid');
  });
});

describe('Linear projects of one team', () => {
  it('lists projects by id and name, with the team id as a variable', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const f = (async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { team: { projects: { nodes: [{ id: 'p-1', name: 'Auth' }, { id: 'p-2', name: 'Billing' }], pageInfo: { hasNextPage: false } } } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const listed = await listLinearProjects({ token: 'lin_api_x' }, 'team-uuid', f);
    expect(listed.items).toEqual([{ id: 'p-1', name: 'Auth' }, { id: 'p-2', name: 'Billing' }]);
    expect(sent[0]!['variables']).toEqual({ id: 'team-uuid' });
    expect(String(sent[0]!['query'])).not.toContain('team-uuid');
  });
});

// Before setup saves a pasted token for a background read, one cheap call: only a clear no is a refusal.
describe('proving a pasted token', () => {
  const answer = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('a 401 from Jira, or Slack saying invalid_auth (with a 200), is refused', async () => {
    expect(await proveToken('jira', JIRA, answer(401))).toBe('refused');
    expect(await proveToken('slack', { token: 'xoxp-x' }, answer(200, { ok: false, error: 'invalid_auth' }))).toBe('refused');
  });
  it('a 200 from Linear, or Slack saying ok, is ok', async () => {
    expect(await proveToken('linear', { token: 'lin_api_x' }, answer(200, { data: { viewer: { id: 'u' } } }))).toBe('ok');
    expect(await proveToken('slack', { token: 'xoxp-x' }, answer(200, { ok: true }))).toBe('ok');
  });
  it('a vendor that cannot be reached, or a source with no check, is unknown, never refused', async () => {
    const offline = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    expect(await proveToken('notion', { token: 'secret_x' }, offline)).toBe('unknown');
    expect(await proveToken('zoom', { token: 'x' }, answer(401))).toBe('unknown');
  });
});
