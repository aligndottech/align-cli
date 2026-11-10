import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { resolveScope } from '../lib/scope.js';
import { type ConnectScopeCtx, decideConnectScope, fetchWithDecision, type PickOption, SKIP_VALUE } from '../lib/scope-connect.js';
import { matchRepoNames } from '../lib/scope-repo-match.js';
import { FIELDS, makeDeps, memStore, type Route } from './helpers/scope-deps.js';

/**
 * ALI-2089 item 2 Test List (skip a source in this repo):
 * - A name match is on whole tokens: an equal word of 3+ characters (split on punctuation, any case), or the whole name equal. Never a
 *   substring: ENG is not engine, ops is not workshops, ali is not calibre.
 * - Two repos, two answers: "fastify" matches nothing in ALI/OPS, "align-cli" matches the team named Align.
 * - The picker always offers "None, skip <Source> in this repo".
 * - It is the preselected answer when nothing matches and nothing was stored; a match is preselected instead; a stored choice wins.
 * - Choosing it reads nothing (the source's fetch is never called), is written only once, and is remembered for the repo.
 * - A stored skip is what a later or background run gets: skipped, never yours, never blocked (Confluence too).
 */
let dir: string;
let dbPath: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-skip-')); dbPath = path.join(dir, 'graph.db'); createLocalGatewayClient(dbPath).close(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const teams = (...keys: Array<[string, string]>): Route => [/api\.linear\.app/, { body: { data: { teams: { nodes: keys.map(([k, n]) => ({ id: `id-${k}`, key: k, name: n })) } } } }];
const spaces = (...keys: string[]): Route => [/wiki\/api\/v2\/spaces/, { body: { results: keys.map((key) => ({ key, name: `Space ${key}` })) } }];
interface Asked { message: string; options: PickOption[]; initial: string[] }

function setup(o: { repo: string[]; table: Route[]; picks?: string[] | null; store?: ReturnType<typeof memStore> }): { ctx: ConnectScopeCtx; asked: Asked[]; said: string[]; store: ReturnType<typeof memStore> } {
  const asked: Asked[] = [];
  const said: string[] = [];
  const store = o.store ?? memStore();
  const deps = makeDeps(dbPath, { table: o.table, store });
  const ctx: ConnectScopeCtx = {
    deps, interactive: true, quiet: false, flags: {}, citedKeys: () => [], say: (l) => said.push(l), repoNames: () => o.repo,
    prompts: {
      multiselect: async (message, options, initial) => { asked.push({ message, options, initial }); return o.picks === undefined ? initial : o.picks; },
      confirm: async () => false,
    },
  };
  return { ctx, asked, said, store };
}

describe('matching a repo to a team, project or space', () => {
  it('matches whole words only: the three substring false matches are gone, and a real match stays', () => {
    expect(matchRepoNames([{ key: 'ENG', name: 'Engineering' }], ['engine'])).toEqual([]);
    expect(matchRepoNames([{ key: 'OPS', name: 'Operations' }], ['workshops'])).toEqual([]);
    expect(matchRepoNames([{ key: 'ALI', name: 'Core' }], ['calibre'])).toEqual([]);
    expect(matchRepoNames([{ key: 'ALI', name: 'Core' }], ['ali-tools'])).toEqual(['ALI']);
    expect(matchRepoNames([{ key: 'ALI', name: 'Align' }], ['align-stack'])).toEqual(['ALI']);
  });
  it('a repo word equal to a word of the name or key, ignoring case (two examples each way)', () => {
    const items = [{ key: 'ALI', name: 'Align' }, { key: 'FASTIFY', name: 'Fastify core' }, { key: 'OPS', name: 'Operations' }];
    expect(matchRepoNames(items, ['align-cli'])).toEqual(['ALI']);
    expect(matchRepoNames(items, ['Fastify'])).toEqual(['FASTIFY']);
    expect(matchRepoNames(items, ['payments-ops-tools'])).toEqual(['OPS']);
    expect(matchRepoNames(items, ['my-fastify-fork', 'x'])).toEqual(['FASTIFY']);
    expect(matchRepoNames(items, ['Operations'])).toEqual(['OPS']);
  });
  it('matches nothing for an unrelated repo, and never on a name shorter than 3 characters', () => {
    const items = [{ key: 'ALI', name: 'Align' }, { key: 'AC', name: 'Acme' }];
    expect(matchRepoNames(items, ['fastify'])).toEqual([]);
    expect(matchRepoNames(items, ['ac'])).toEqual([]);
    expect(matchRepoNames(items, ['payments-acme'])).toEqual(['AC']);
  });
});

describe('the picker offers skip, and defaults to it when nothing matches', () => {
  it('Linear in a fastify clone: skip is offered and preselected; the other teams are still listed', async () => {
    const s = setup({ repo: ['fastify'], table: [teams(['ALI', 'Align'], ['OPS', 'Operations'])] });
    await decideConnectScope('linear', { token: 'x' }, s.ctx);
    expect(s.asked[0]!.options[0]).toMatchObject({ value: SKIP_VALUE, label: 'None, skip Linear in this repo' });
    expect(s.asked[0]!.options.map((x) => x.value)).toEqual([SKIP_VALUE, 'ALI', 'OPS']);
    expect(s.asked[0]!.initial).toEqual([SKIP_VALUE]);
  });
  it('a matching team is preselected instead (the align-cli repo and the Align team)', async () => {
    const s = setup({ repo: ['align-cli'], table: [teams(['ALI', 'Align'], ['OPS', 'Operations'])] });
    await decideConnectScope('linear', { token: 'x' }, s.ctx);
    expect(s.asked[0]!.initial).toEqual(['ALI']);
  });
  it('Jira and Confluence get the same option, labelled with their own name', async () => {
    const jira = setup({ repo: ['fastify'], table: [[/rest\/api\/3\/project\/search/, { body: { values: [{ key: 'ABC', name: 'Abc' }], isLast: true } }]] });
    await decideConnectScope('jira', FIELDS['jira']!, jira.ctx);
    expect(jira.asked[0]!.options[0]!.label).toBe('None, skip Jira in this repo');
    expect(jira.asked[0]!.initial).toEqual([SKIP_VALUE]);
    const conf = setup({ repo: ['fastify'], table: [spaces('ENG')] });
    await decideConnectScope('confluence', FIELDS['confluence']!, conf.ctx);
    expect(conf.asked[0]!.options[0]!.label).toBe('None, skip Confluence in this repo');
    expect(conf.asked[0]!.initial).toEqual([SKIP_VALUE]);
  });
  it('a stored choice wins over both: a stored team stays preselected, a stored skip is preselected again', async () => {
    const team = setup({ repo: ['fastify'], table: [teams(['ALI', 'Align'])], store: memStore({ scopes: { linear: { kind: 'team', values: ['id-ALI'], labels: ['ALI'] } } }) });
    await decideConnectScope('linear', { token: 'x' }, team.ctx);
    expect(team.asked[0]!.initial).toEqual(['ALI']);
    const skip = setup({ repo: ['align-cli'], table: [teams(['ALI', 'Align'])], store: memStore({ scopes: { linear: { kind: 'skip' } } }) });
    await decideConnectScope('linear', { token: 'x' }, skip.ctx);
    expect(skip.asked[0]!.initial).toEqual([SKIP_VALUE]);
  });
});

describe('choosing skip', () => {
  it('reads nothing, writes the skip only on commit, and a later run gets skipped (not yours)', async () => {
    const s = setup({ repo: ['fastify'], table: [teams(['ALI', 'Align'])] });
    const d = await decideConnectScope('linear', { token: 'x' }, s.ctx);
    expect(d.skipped).toBe(true);
    expect(s.store.scopes['linear']).toBeUndefined();
    const fetch = vi.fn();
    const out = await fetchWithDecision({ id: 'linear', fetch }, { token: 'x' }, undefined, d);
    expect(fetch).not.toHaveBeenCalled();
    expect(out.items).toEqual([]);
    expect(out.report.skippedInRepo).toBe(true);
    expect(s.store.scopes['linear']).toEqual({ kind: 'skip' });
    const later = await resolveScope('linear', s.ctx.deps, { foreground: false });
    expect(later.skipped).toMatch(/Linear is skipped in this repo/);
    expect(later.skipped).toContain('align connect --source linear');
  });
  it('skip beats a team ticked beside it (reading nothing is the narrower answer)', async () => {
    const s = setup({ repo: ['fastify'], table: [teams(['ALI', 'Align'])], picks: [SKIP_VALUE, 'ALI'] });
    expect((await decideConnectScope('linear', { token: 'x' }, s.ctx)).skipped).toBe(true);
  });
  it('Confluence skipped is skipped, not "needs spaces"', async () => {
    const store = memStore({ scopes: { confluence: { kind: 'skip' } } });
    const r = await resolveScope('confluence', makeDeps(dbPath, { store }), { foreground: false });
    expect(r.skipped).toBeDefined();
    expect(r.blocked).toBeUndefined();
  });
  it('an unattended run with a stored skip is skipped, and one with nothing stored is not', async () => {
    const skipped = setup({ repo: ['x'], table: [], store: memStore({ scopes: { linear: { kind: 'skip' } } }) });
    skipped.ctx.interactive = false;
    expect((await decideConnectScope('linear', { token: 'x' }, skipped.ctx)).skipped).toBe(true);
    const none = setup({ repo: ['x'], table: [] });
    none.ctx.interactive = false;
    expect((await decideConnectScope('linear', { token: 'x' }, none.ctx)).skipped).toBeUndefined();
  });
});

describe('the second question starts on the board or project named like this repo (ALI-2089 item 3)', () => {
  const linear: Route = [/api\.linear\.app/, { body: { data: {
    teams: { nodes: [{ id: 't-1', key: 'ENG', name: 'Eng' }], pageInfo: {} },
    team: { projects: { nodes: [{ id: 'p-1', name: 'Auth service' }, { id: 'p-2', name: 'Billing' }], pageInfo: {} } },
  } } }];
  const run = async (repo: string[]): Promise<string[]> => {
    const selected: string[][] = [];
    const s = setup({ repo, table: [linear], picks: ['ENG'] });
    s.ctx.prompts.select = async (_m, _o, initial) => initial;
    const first = s.ctx.prompts.multiselect;
    s.ctx.prompts.multiselect = async (m, o, initial, req) => {
      if (!m.startsWith('Which projects of')) return first(m, o, initial, req);
      selected.push(initial);
      return initial;
    };
    await decideConnectScope('linear', { token: 'x' }, s.ctx);
    return selected[0]!;
  };
  it('exactly one project named like the repo is where the cursor starts (two repos, two answers)', async () => {
    expect(await run(['billing-api'])).toEqual(['p-2']);
    expect(await run(['auth-service'])).toEqual(['p-1']);
  });
  it('no match, or two matches, starts on all of the team', async () => {
    expect(await run(['fastify'])).toEqual([':all']);
    expect(await run(['auth-service-billing'])).toEqual([':all']);
  });
});

describe('outside a git repo there is nothing to skip it for (ALI-2089 review)', () => {
  it('the picker does not offer skip, and nothing is preselected', async () => {
    const s = setup({ repo: ['somefolder'], table: [teams(['ALI', 'Align'])] });
    s.ctx.inRepo = () => false;
    await decideConnectScope('linear', { token: 'x' }, s.ctx);
    expect(s.asked[0]!.options.map((x) => x.value)).toEqual(['ALI']);
    expect(s.asked[0]!.initial).toEqual([]);
  });
  it('a skip answer that arrives anyway is refused in plain words and stores nothing', async () => {
    const s = setup({ repo: ['somefolder'], table: [teams(['ALI', 'Align'])], picks: [SKIP_VALUE] });
    s.ctx.inRepo = () => false;
    await expect(decideConnectScope('linear', { token: 'x' }, s.ctx)).rejects.toThrow(/git repo/);
    expect(s.store.scopes['linear']).toBeUndefined();
  });
});
