import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { chooseScope, resolveScope, type ScopeRefusal, setScope } from '../lib/scope.js';
import { FIELDS, jiraProjects, makeDeps, memStore, type Route } from './helpers/scope-deps.js';

/**
 * Choosing a narrowing: one board (or a JQL) inside one Jira project, or projects inside one Linear team. It goes through the
 * same check, refuse and commit path as a team scope, so an agent's choice waits for a person, and a refused value is never
 * printed back.
 *
 * Test List:
 * - Jira board by exact name, and by id (two examples): narrowed to the board, its own key and words.
 * - A board the token cannot see: not_visible. Two boards sharing a name: asks for the id. Both refusals hide the value.
 * - A board or JQL with more than one project, or both together: invalid.
 * - A JQL Jira refuses: invalid, and the JQL is not printed. Over 2,000 characters: refused before any request.
 * - Linear projects by name inside one team: narrowed to their ids.
 * - Committed and read back: the fetch gets the narrowing, the disclosure names the part.
 * - An agent's board choice waits for a person, like a team choice.
 * - Narrowing a source that has no parts (Confluence): invalid.
 */

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-narrow-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalGatewayClient(dbPath).close();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const boards = (...b: Array<[number, string]>): Route => [/\/rest\/agile\/1\.0\/board\?projectKeyOrId=AC/, { body: { isLast: true, values: b.map(([id, name]) => ({ id, name })) } }];
const filterOf: Route[] = [
  [/\/board\/42\/configuration/, { body: { filter: { id: '10001' } } }],
  [/\/rest\/api\/3\/filter\/10001/, { body: { jql: 'project = AC AND team = 7 ORDER BY Rank' } }],
];
const searchOk: Route = [/\/rest\/api\/3\/search\/jql/, { status: 200, body: {} }];
const searchBad: Route = [/\/rest\/api\/3\/search\/jql/, { status: 400, body: {} }];
const linear = (teams: unknown, projects: unknown): Route => [/api\.linear\.app/, { body: { data: { teams, team: { projects } } } }];

const deps = (table: Route[], store = memStore()) => makeDeps(dbPath, { table, store });
const refusal = async (p: Promise<unknown>): Promise<ScopeRefusal> => { try { await p; } catch (e) { return e as ScopeRefusal; } throw new Error('not refused'); };

describe('choosing a Jira board', () => {
  it('by exact name: narrowed to that board, with its own key and words', async () => {
    const d = deps([jiraProjects('AC'), boards([42, 'Payments'], [43, 'Payouts']), ...filterOf, searchOk]);
    const c = await chooseScope(d, 'jira', { scope: 'team', values: 'AC', narrow: { board: 'Payments' } }, FIELDS['jira']!);
    expect(c.narrow).toEqual({ by: 'board', id: '42', name: 'Payments', jql: 'project = AC AND team = 7 ORDER BY Rank' });
    expect(c.scopeKey).toBe('jira:AC#board=42');
    expect(c.label).toBe('issues on the Payments board in Jira project AC');
  });

  it('by id: the same board', async () => {
    const d = deps([jiraProjects('AC'), boards([42, 'Payments']), ...filterOf, searchOk]);
    const c = await chooseScope(d, 'jira', { scope: 'team', values: 'AC', narrow: { board: '42' } }, FIELDS['jira']!);
    expect(c.narrow).toMatchObject({ by: 'board', id: '42', name: 'Payments' });
  });

  it('a board the token cannot see is not_visible, and its name is not printed', async () => {
    const e = await refusal(chooseScope(deps([jiraProjects('AC'), boards([42, 'Payments'])]), 'jira', { scope: 'team', values: 'AC', narrow: { board: 'Secret Ops' } }, FIELDS['jira']!));
    expect(e.kind).toBe('not_visible');
    expect(e.message).not.toContain('Secret Ops');
  });

  it('two boards with one name ask for the id', async () => {
    const e = await refusal(chooseScope(deps([jiraProjects('AC'), boards([42, 'Team'], [43, 'Team'])]), 'jira', { scope: 'team', values: 'AC', narrow: { board: 'Team' } }, FIELDS['jira']!));
    expect(e.kind).toBe('invalid');
    expect(e.message).toContain('id');
  });

  it('a board needs exactly one project, and a board and a JQL cannot both be given', async () => {
    const two = await refusal(chooseScope(deps([jiraProjects('AC', 'OPS')]), 'jira', { scope: 'team', values: 'AC,OPS', narrow: { board: '42' } }, FIELDS['jira']!));
    expect(two.kind).toBe('invalid');
    const both = await refusal(chooseScope(deps([jiraProjects('AC')]), 'jira', { scope: 'team', values: 'AC', narrow: { board: '42', jql: 'labels = x' } }, FIELDS['jira']!));
    expect(both.kind).toBe('invalid');
  });
});

describe('choosing a Jira JQL', () => {
  it('a JQL Jira refuses is invalid, and the JQL is not printed', async () => {
    const e = await refusal(chooseScope(deps([jiraProjects('AC'), searchBad]), 'jira', { scope: 'team', values: 'AC', narrow: { jql: 'labelz = payments' } }, FIELDS['jira']!));
    expect(e.kind).toBe('invalid');
    expect(e.message).not.toContain('labelz');
  });

  it('over 2,000 characters is refused before any request', async () => {
    const d = deps([jiraProjects('AC'), searchOk]);
    const e = await refusal(chooseScope(d, 'jira', { scope: 'team', values: 'AC', narrow: { jql: `labels = ${'x'.repeat(2001)}` } }, FIELDS['jira']!));
    expect(e.kind).toBe('invalid');
    expect(d.calls.filter((c) => c.includes('/search/jql'))).toEqual([]);
  });
});

describe('choosing Linear projects', () => {
  it('by name inside one team: narrowed to their ids', async () => {
    const d = deps([linear({ nodes: [{ id: 't-1', key: 'ENG', name: 'Eng' }], pageInfo: {} }, { nodes: [{ id: 'p-1', name: 'Auth' }, { id: 'p-2', name: 'Billing' }], pageInfo: {} })]);
    const c = await chooseScope(d, 'linear', { scope: 'team', values: 'ENG', narrow: { projects: 'Billing' } }, FIELDS['linear']!);
    expect(c.narrow).toEqual({ by: 'projects', ids: ['p-2'], names: ['Billing'] });
    expect(c.scopeKey).toBe('linear:ENG#projects=p-2');
  });
});

describe('a committed narrowing', () => {
  it('is read back with the narrowing in the fetch and the part in the disclosure', async () => {
    const store = memStore();
    const d = deps([jiraProjects('AC'), boards([42, 'Payments']), ...filterOf, searchOk], store);
    await setScope(d, 'jira', { scope: 'team', values: 'AC', narrow: { board: 'Payments' } }, { via: 'cli' });
    const r = await resolveScope('jira', { ...d, store }, { foreground: true });
    expect(r.extras).toEqual({ projects: ['AC'], jql: 'project = AC AND team = 7 ORDER BY Rank' });
    expect(r.scopeKey).toBe('jira:AC#board=42');
    expect(r.disclosure).toContain('issues on the Payments board in Jira project AC');
  });

  it("an agent's board choice waits for a person, like a team choice", async () => {
    const store = memStore();
    const d = deps([jiraProjects('AC'), boards([42, 'Payments']), ...filterOf, searchOk], store);
    const res = await setScope(d, 'jira', { scope: 'team', values: 'AC', narrow: { board: 'Payments' } }, { via: 'mcp', agent: 'claude-code' });
    expect(res.pending).toBe(true);
    const r = await resolveScope('jira', { ...d, store, isTty: () => false }, { foreground: false });
    expect(r.scope).toBe('yours');
  });
});

describe('a source with no parts', () => {
  it('Confluence cannot be narrowed', async () => {
    const e = await refusal(chooseScope(deps([]), 'confluence', { scope: 'team', values: 'ENG', narrow: { board: '1' } }, FIELDS['confluence']!));
    expect(e.kind).toBe('invalid');
  });
});

// A narrowing is a consent boundary, and an older connector-core silently ignores it. So a CLI whose connector-core does not
// narrow refuses to choose one, and blocks reading a stored one, rather than reading the whole project.
describe('when the installed connector-core cannot narrow', () => {
  it('choosing a narrowing is refused, and says to update', async () => {
    const d = { ...deps([jiraProjects('AC'), boards([42, 'Payments']), ...filterOf, searchOk]), coreNarrows: () => false };
    const e = await refusal(chooseScope(d, 'jira', { scope: 'team', values: 'AC', narrow: { board: 'Payments' } }, FIELDS['jira']!));
    expect(e.kind).toBe('invalid');
    expect(e.message).toMatch(/update/i);
  });

  it('a stored narrowing is blocked, never read as the whole project (two sources)', async () => {
    const store = memStore({ scopes: {
      jira: { kind: 'team', values: ['AC'], labels: ['AC'], narrow: { by: 'jql', jql: 'labels = pay' } },
      linear: { kind: 'team', values: ['t-1'], labels: ['ENG'], narrow: { by: 'projects', ids: ['p-1'], names: ['Auth'] } },
    }, disclosed: ['jira', 'linear'] });
    for (const source of ['jira', 'linear']) {
      const r = await resolveScope(source, { ...deps([], store), coreNarrows: () => false }, { foreground: false });
      expect(r.blocked).toMatch(/update/i);
    }
  });

  it('a stored scope with no narrowing still reads as before', async () => {
    const store = memStore({ scopes: { jira: { kind: 'team', values: ['AC'], labels: ['AC'] } }, disclosed: ['jira'] });
    const r = await resolveScope('jira', { ...deps([], store), coreNarrows: () => false }, { foreground: false });
    expect(r.blocked).toBeUndefined();
    expect(r.extras).toEqual({ projects: ['AC'] });
  });
});

describe('a narrowing cannot widen the read', () => {
  it("a board's filter over 2,000 characters is refused", async () => {
    const long: Route[] = [[/\/board\/42\/configuration/, { body: { filter: { id: '10001' } } }], [/\/rest\/api\/3\/filter\/10001/, { body: { jql: `labels = ${'x'.repeat(2001)}` } }]];
    const e = await refusal(chooseScope(deps([jiraProjects('AC'), boards([42, 'Payments']), ...long, searchOk]), 'jira', { scope: 'team', values: 'AC', narrow: { board: '42' } }, FIELDS['jira']!));
    expect(e.kind).toBe('invalid');
  });

  it('a JQL that tries to close the project clause is refused', async () => {
    const e = await refusal(chooseScope(deps([jiraProjects('AC'), searchOk]), 'jira', { scope: 'team', values: 'AC', narrow: { jql: 'x = 1) OR (project = SECRET' } }, FIELDS['jira']!));
    expect(e.kind).toBe('invalid');
    expect(e.message).not.toContain('SECRET');
  });
});
