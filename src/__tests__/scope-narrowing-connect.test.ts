import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { runScopeTool } from '../lib/mcp-scope.js';
import { checkScopeFlags, type ConnectScopeCtx, decideConnectScope, type PickOption } from '../lib/scope-connect.js';
import { FIELDS, jiraProjects, makeDeps, memStore, type Route } from './helpers/scope-deps.js';

/**
 * The second setup question: after a person at a terminal picks ONE Jira project or ONE Linear team, "Read all of it, or one
 * board/project?". All of it is the first answer and where the cursor starts; a board or project goes through the same checks
 * as `--board` and the agent tool.
 *
 * Test List:
 * - Jira: one project picked, its boards listed, a board chosen: the read narrows to that board.
 * - Linear: one team picked, its projects listed, a project chosen: the read narrows to it.
 * - "All of" is first and the cursor starts there; choosing it reads the whole project (today's behaviour).
 * - Two projects picked, or no boards: no second question.
 * - Boards cannot be listed: said, and the whole project is read.
 * - A board chosen before is where the cursor starts next time.
 */

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-narrow-connect-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalGatewayClient(dbPath).close();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

interface Selected { message: string; options: PickOption[]; initial: string }

function setup(o: { picks: string[]; answer?: string | null; table: Route[]; store?: ReturnType<typeof memStore> }) {
  const said: string[] = [];
  const selected: Selected[] = [];
  const deps = makeDeps(dbPath, { table: o.table, ...(o.store ? { store: o.store } : {}) });
  const ctx: ConnectScopeCtx = {
    deps, interactive: true, quiet: false, flags: {},
    prompts: {
      multiselect: async () => o.picks,
      confirm: async () => false,
      select: async (message, options, initial) => { selected.push({ message, options, initial }); return o.answer === undefined ? initial : o.answer; },
    },
    citedKeys: () => [], say: (l) => said.push(l),
  };
  return { ctx, said, selected };
}

const boards = (...b: Array<[number, string]>): Route => [/\/rest\/agile\/1\.0\/board\?projectKeyOrId=AC/, { body: { isLast: true, values: b.map(([id, name]) => ({ id, name })) } }];
const filterOf: Route[] = [
  [/\/board\/42\/configuration/, { body: { filter: { id: '10001' } } }],
  [/\/rest\/api\/3\/filter\/10001/, { body: { jql: 'project = AC AND team = 7' } }],
];
const searchOk: Route = [/\/rest\/api\/3\/search\/jql/, { status: 200, body: {} }];
const linear: Route = [/api\.linear\.app/, { body: { data: {
  teams: { nodes: [{ id: 't-1', key: 'ENG', name: 'Eng' }], pageInfo: {} },
  team: { projects: { nodes: [{ id: 'p-1', name: 'Auth' }, { id: 'p-2', name: 'Billing' }], pageInfo: {} } },
} } }];

describe('the second setup question', () => {
  it('jira: one project, a board chosen, reads that board', async () => {
    const s = setup({ picks: ['AC'], answer: '42', table: [jiraProjects('AC'), boards([42, 'Payments'], [43, 'Payouts']), ...filterOf, searchOk] });
    const d = await decideConnectScope('jira', FIELDS['jira']!, s.ctx);
    expect(s.selected[0]!.message).toBe('Read all of AC, or one board?');
    expect(d.extras).toMatchObject({ projects: ['AC'], jql: 'project = AC AND team = 7' });
    expect(d.label).toBe('issues on the Payments board in Jira project AC');
  });

  it('linear: one team, a project chosen, reads that project', async () => {
    const s = setup({ picks: ['ENG'], answer: 'p-2', table: [linear] });
    const d = await decideConnectScope('linear', FIELDS['linear']!, s.ctx);
    expect(s.selected[0]!.message).toBe('Read all of ENG, or one project?');
    expect(d.extras).toMatchObject({ teams: ['t-1'], projects: ['p-2'] });
  });

  it('"All of" is first, the cursor starts there, and choosing it reads the whole project', async () => {
    const s = setup({ picks: ['AC'], table: [jiraProjects('AC'), boards([42, 'Payments'])] });
    const d = await decideConnectScope('jira', FIELDS['jira']!, s.ctx);
    expect(s.selected[0]!.options[0]!.label).toBe('All of AC');
    expect(s.selected[0]!.initial).toBe(s.selected[0]!.options[0]!.value);
    expect(d.extras).toEqual({ resolved: true, projects: ['AC'] });
  });

  it('two projects picked, or a project with no boards: no second question', async () => {
    const two = setup({ picks: ['AC', 'OPS'], table: [jiraProjects('AC', 'OPS')] });
    await decideConnectScope('jira', FIELDS['jira']!, two.ctx);
    expect(two.selected).toEqual([]);
    const none = setup({ picks: ['AC'], table: [jiraProjects('AC'), boards()] });
    await decideConnectScope('jira', FIELDS['jira']!, none.ctx);
    expect(none.selected).toEqual([]);
  });

  it('boards that cannot be listed are said, and the whole project is read', async () => {
    const s = setup({ picks: ['AC'], table: [jiraProjects('AC'), [/\/rest\/agile\/1\.0\/board\?/, { status: 500 }]] });
    const d = await decideConnectScope('jira', FIELDS['jira']!, s.ctx);
    expect(s.said.some((l) => l.startsWith('Could not list the boards in AC'))).toBe(true);
    expect(d.extras).toEqual({ resolved: true, projects: ['AC'] });
  });

  it('a board chosen before is where the cursor starts', async () => {
    const store = memStore({ scopes: { jira: { kind: 'team', values: ['AC'], labels: ['AC'], narrow: { by: 'board', id: '43', name: 'Payouts', jql: 'x = 1' } } } });
    const s = setup({ picks: ['AC'], table: [jiraProjects('AC'), boards([42, 'Payments'], [43, 'Payouts'])], store });
    await decideConnectScope('jira', FIELDS['jira']!, s.ctx).catch(() => undefined);
    expect(s.selected[0]!.initial).toBe('43');
  });
});

describe('narrowing by flag', () => {
  it('--board and --jql are Jira only, need --projects, and not with --scope yours', () => {
    expect(checkScopeFlags('jira', { projects: 'AC', board: 'Payments' })).toBeUndefined();
    expect(checkScopeFlags('jira', { projects: 'AC', jql: 'labels = x' })).toBeUndefined();
    expect(checkScopeFlags('jira', { board: 'Payments' })).toMatch(/--board needs --projects/);
    expect(checkScopeFlags('linear', { teams: 'ENG', board: '1' })).toMatch(/--board is for Jira/);
    expect(checkScopeFlags('jira', { scope: 'yours', board: '1' })).toMatch(/not both/);
  });

  it('--linear-projects is Linear only and needs --teams', () => {
    expect(checkScopeFlags('linear', { teams: 'ENG', linearProjects: 'Billing' })).toBeUndefined();
    expect(checkScopeFlags('linear', { linearProjects: 'Billing' })).toMatch(/--linear-projects needs --teams/);
    expect(checkScopeFlags('jira', { projects: 'AC', linearProjects: 'Billing' })).toMatch(/--linear-projects is for Linear/);
  });

  it('a person passing --board reads that board, through the same checks', async () => {
    const said: string[] = [];
    const deps = makeDeps(dbPath, { table: [jiraProjects('AC'), boards([42, 'Payments']), ...filterOf, searchOk] });
    const ctx: ConnectScopeCtx = {
      deps, interactive: true, quiet: false, flags: { projects: 'AC', board: 'Payments' },
      prompts: { multiselect: async () => null, confirm: async () => false },
      citedKeys: () => [], say: (l) => said.push(l),
    };
    const d = await decideConnectScope('jira', FIELDS['jira']!, ctx);
    expect(d.extras).toMatchObject({ projects: ['AC'], jql: 'project = AC AND team = 7' });
  });
});

// An agent can narrow too, by board (Jira) or projects (Linear), never by raw JQL; and its choice waits for a person.
describe('the align_scope tool narrows', () => {
  const env = () => ({ mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: dbPath }) as never;

  it('an agent picks a Jira board: it waits for the person', async () => {
    const store = memStore();
    const deps = makeDeps(dbPath, { table: [jiraProjects('AC'), boards([42, 'Payments']), ...filterOf, searchOk], store });
    const r = await runScopeTool({ action: 'set', source: 'jira', projects: ['AC'], board: 'Payments' }, env(), deps, { agent: 'claude-code' });
    expect(r).toMatchObject({ pending: true, scope_key: 'jira:AC#board=42' });
  });

  it('an agent picks Linear projects: it waits for the person', async () => {
    const store = memStore();
    const deps = makeDeps(dbPath, { table: [linear], store });
    const r = await runScopeTool({ action: 'set', source: 'linear', teams: ['ENG'], linear_projects: ['Billing'] }, env(), deps, { agent: 'claude-code' });
    expect(r).toMatchObject({ pending: true, scope_key: 'linear:ENG#projects=p-2' });
  });

  it('board is Jira only, linear_projects Linear only, and raw JQL is not accepted from an agent', async () => {
    const deps = makeDeps(dbPath, { table: [] });
    await expect(runScopeTool({ action: 'set', source: 'linear', teams: ['ENG'], board: '1' }, env(), deps, { agent: 'a' })).rejects.toThrow(/board/);
    await expect(runScopeTool({ action: 'set', source: 'jira', projects: ['AC'], linear_projects: ['x'] }, env(), deps, { agent: 'a' })).rejects.toThrow(/linear_projects/);
    await expect(runScopeTool({ action: 'set', source: 'jira', projects: ['AC'], jql: 'labels = x' }, env(), deps, { agent: 'a' })).rejects.toThrow(/unknown propert/);
    await expect(runScopeTool({ action: 'set', source: 'jira', scope: 'yours', board: '42' }, env(), deps, { agent: 'a' })).rejects.toThrow(/board/);
  });
});
