import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { runScopeTool } from '../lib/mcp-scope.js';
import { scopeOf } from '../lib/sync/sources.js';
import { checkScopeFlags, type ConnectScopeCtx, decideConnectScope, fetchUnderScope, type PickOption, type ScopeFlags } from '../lib/scope-connect.js';
import { readRows } from '../lib/sync/sync-state.js';
import { FIELDS, jiraProjects, makeDeps, memStore, type Route } from './helpers/scope-deps.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * L4 Test List (choosing a scope during `align connect --source <x>` and `align setup`):
 * GitHub / GitLab (no question: the folder's remote decides)
 * - Inside a repo the token can see: team on it, the disclosure printed once before the fetch and marked told; told already: no line.
 * - A repo the token cannot see: yours, the reconnect line printed; no folder at all: yours, with how to read a repo.
 * - --scope yours wins over the folder; --repo o/r is checked against the token and refused (before any fetch) when it cannot see it.
 * Jira / Linear
 * - Interactive: a picker lists what the token can see, preselects the keys local decisions cite (or the stored choice), and its
 *   answer is the scope; nothing selected means yours; a cancelled picker changes nothing.
 * - Not interactive: a flag; else the stored choice; else the cited keys that the token can see; else yours with how to widen.
 * - A list that cannot be read never blocks the connect: yours, and the reason is said.
 * Confluence
 * - Needs spaces: picked, flagged or stored; with none, the connect is refused with the command, before any fetch.
 * Zoom says it is only yours; Slack, Notion and Teams say nothing.
 * Order and persistence
 * - The disclosure comes before the fetch; the choice is written only after the fetch succeeded; a failed fetch writes nothing.
 * - Quiet (--json) prints nothing and does not mark the disclosure told.
 * - Flag checks: a scope flag needs --source; each value flag belongs to one source; yours and a value contradict.
 */
let dir: string;
let dbPath: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l4-connect-')); dbPath = path.join(dir, 'graph.db'); createLocalGatewayClient(dbPath).close(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

interface Asked { message: string; options: PickOption[]; initial: string[]; required: boolean }
function setup(o: {
  interactive?: boolean; quiet?: boolean; flags?: ScopeFlags; picks?: string[] | null; cited?: string[];
  table?: Route[]; store?: ReturnType<typeof memStore>; cwdRepo?: string; cwdGitlab?: string;
} = {}): { ctx: ConnectScopeCtx; said: string[]; asked: Asked[]; deps: ReturnType<typeof makeDeps> } {
  const said: string[] = [];
  const asked: Asked[] = [];
  const deps = makeDeps(dbPath, {
    ...(o.table ? { table: o.table } : {}), ...(o.store ? { store: o.store } : {}),
    cwdRepo: async () => o.cwdRepo, cwdGitlabProject: async () => o.cwdGitlab,
  });
  const ctx: ConnectScopeCtx = {
    deps, interactive: o.interactive ?? false, quiet: o.quiet ?? false, flags: o.flags ?? {},
    prompts: { multiselect: async (message, options, initial, opt) => { asked.push({ message, options, initial, required: opt.required }); return o.picks === undefined ? initial : o.picks; } },
    citedKeys: () => o.cited ?? [], say: (l) => said.push(l),
  };
  return { ctx, said, asked, deps };
}
const SEARCH: Route = [/api\.github\.com\/search\/issues/, { status: 200 }];
const TOKENS = { jira: FIELDS['jira']!, linear: FIELDS['linear']!, github: FIELDS['github']!, confluence: FIELDS['confluence']!, gitlab: FIELDS['gitlab']! };
const teams = (...keys: string[]): Route => [/api\.linear\.app/, { body: { data: { teams: { nodes: keys.map((k) => ({ id: `id-${k}`, key: k, name: `Team ${k}` })) } } } }];
const spaces = (...keys: string[]): Route => [/wiki\/api\/v2\/spaces/, { body: { results: keys.map((key) => ({ key, name: `Space ${key}` })) } }];

describe('GitHub', () => {
  it('inside a repo the token can see: team, resolved extras with the repo, the disclosure said once and marked', async () => {
    for (const interactive of [true, false]) {
      const s = setup({ interactive, cwdRepo: 'o/r', table: [SEARCH] });
      const d = await decideConnectScope('github', TOKENS.github, s.ctx);
      expect(d).toMatchObject({ scope: 'team', extras: { resolved: true, repo: 'o/r', team: true }, label: "everyone's items in o/r" });
      expect(s.said).toHaveLength(1);
      expect(s.said[0]).toContain('Importing items from everyone in o/r that your token can read. They stay on this machine.');
      expect(s.deps.store.disclosed.has('github')).toBe(true);
      expect(s.asked).toEqual([]);
    }
  });

  it('already told: no line. Quiet: no line and not marked as told (two cases)', async () => {
    const told = setup({ cwdRepo: 'o/r', table: [SEARCH], store: memStore({ disclosed: ['github'] }) });
    await decideConnectScope('github', TOKENS.github, told.ctx);
    expect(told.said).toEqual([]);
    const quiet = setup({ quiet: true, cwdRepo: 'o/r', table: [SEARCH] });
    await decideConnectScope('github', TOKENS.github, quiet.ctx);
    expect(quiet.said).toEqual([]);
    expect(quiet.deps.store.disclosed.has('github')).toBe(false);
  });

  it('quiet with a CHOSEN scope (a flag) prints nothing and does not mark it told either', async () => {
    const s = setup({ quiet: true, flags: { projects: 'ALI' }, table: [jiraProjects('ALI')] });
    await decideConnectScope('jira', TOKENS.jira, s.ctx);
    expect(s.said).toEqual([]);
    expect(s.deps.store.disclosed.has('jira')).toBe(false);
  });

  it('a repo the token cannot see: yours, resolved with no repo, and the line is said', async () => {
    const s = setup({ cwdRepo: 'aligndottech/align-stack', table: [[/api\.github\.com\/search/, { status: 422 }]] });
    const d = await decideConnectScope('github', TOKENS.github, s.ctx);
    expect(d).toMatchObject({ scope: 'yours', extras: { resolved: true } });
    expect(d.extras.repo).toBeUndefined();
    expect(s.said.join('\n')).toContain('Your GitHub token cannot see aligndottech/align-stack');
    expect(s.said.join('\n')).toContain('align connect github');
  });

  it('no folder: yours, and the line says how to read a repo', async () => {
    const s = setup();
    const d = await decideConnectScope('github', TOKENS.github, s.ctx);
    expect(d).toMatchObject({ scope: 'yours', extras: { resolved: true } });
    expect(s.said.join('\n')).toContain('align connect --source github --repo owner/repo');
  });

  it('--scope yours wins over the folder, makes no probe, and is written down after the fetch', async () => {
    const s = setup({ cwdRepo: 'o/r', flags: { scope: 'yours' }, table: [SEARCH] });
    const d = await decideConnectScope('github', TOKENS.github, s.ctx);
    expect(d.scope).toBe('yours');
    expect(s.deps.calls).toHaveLength(0);
    expect(s.deps.store.scopes['github']).toBeUndefined();
    d.commit();
    expect(s.deps.store.scopes['github']).toEqual({ kind: 'yours' });
  });

  it('--repo checks the token before anything is fetched: seen is team, unseen is a refusal naming the repo (two outcomes)', async () => {
    const ok = setup({ flags: { repo: 'x/y' }, table: [SEARCH] });
    expect(await decideConnectScope('github', TOKENS.github, ok.ctx)).toMatchObject({ scope: 'team', extras: { resolved: true, repo: 'x/y', team: true } });
    const no = setup({ flags: { repo: 'x/y' }, table: [[/search/, { status: 422 }]] });
    await expect(decideConnectScope('github', TOKENS.github, no.ctx)).rejects.toThrow(/cannot see x\/y/);
  });

  it('the in-flight token is the one used to check, not a saved one (a first connect has none saved)', async () => {
    const s = setup({ flags: { repo: 'x/y' }, table: [SEARCH], store: memStore({ connected: [] }) });
    await decideConnectScope('github', { token: 'IN-FLIGHT-TOKEN-12345' }, s.ctx);
    expect(s.deps.calls).toHaveLength(1);
  });
});

describe('Jira', () => {
  it('interactive: lists what the token can see, preselects the cited keys it can see, and the answer is the scope', async () => {
    const s = setup({ interactive: true, cited: ['ALI', 'GONE', 'OPS'], table: [jiraProjects('ALI', 'BETA', 'OPS')], picks: ['OPS', 'BETA'] });
    const d = await decideConnectScope('jira', TOKENS.jira, s.ctx);
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]!.options.map((x) => x.value)).toEqual(['ALI', 'BETA', 'OPS']);
    expect(s.asked[0]!.initial).toEqual(['ALI', 'OPS']);
    expect(s.asked[0]!.required).toBe(false);
    expect(s.asked[0]!.message).toContain('only your own');
    expect(d).toMatchObject({ scope: 'team', extras: { resolved: true, projects: ['BETA', 'OPS'] }, label: "everyone's items in Jira projects BETA, OPS" });
    expect(s.said.join('\n')).toContain('everyone in Jira projects BETA, OPS');
  });

  it('interactive with a stored choice: that choice is what is preselected (cited keys are not)', async () => {
    const store = memStore({ scopes: { jira: { kind: 'team', values: ['BETA'], labels: ['BETA'] } } });
    const s = setup({ interactive: true, cited: ['ALI'], table: [jiraProjects('ALI', 'BETA')], store });
    await decideConnectScope('jira', TOKENS.jira, s.ctx);
    expect(s.asked[0]!.initial).toEqual(['BETA']);
  });

  it('interactive: nothing selected is yours, written down after the fetch; a cancelled picker changes nothing (two answers)', async () => {
    const store = memStore({ scopes: { jira: { kind: 'team', values: ['BETA'], labels: ['BETA'] } } });
    const none = setup({ interactive: true, picks: [], table: [jiraProjects('BETA')], store });
    const d = await decideConnectScope('jira', TOKENS.jira, none.ctx);
    expect(d.scope).toBe('yours');
    expect(none.deps.store.scopes['jira']).toBeDefined();
    d.commit();
    expect(none.deps.store.scopes['jira']).toEqual({ kind: 'yours' });
    const cancel = setup({ interactive: true, picks: null, table: [jiraProjects('BETA')], store: memStore({ scopes: { jira: { kind: 'team', values: ['BETA'], labels: ['BETA'] } } }) });
    const c = await decideConnectScope('jira', TOKENS.jira, cancel.ctx);
    expect(c.scope).toBe('team');
    c.commit();
    expect(cancel.deps.store.scopes['jira']).toBeDefined();
  });

  it('--projects is checked against the token and used with no picker (two examples)', async () => {
    const s = setup({ interactive: true, flags: { projects: 'ops,ALI' }, table: [jiraProjects('ALI', 'OPS')] });
    expect(await decideConnectScope('jira', TOKENS.jira, s.ctx)).toMatchObject({ scope: 'team', extras: { projects: ['ALI', 'OPS'] } });
    expect(s.asked).toEqual([]);
    const bad = setup({ flags: { projects: 'NOPE' }, table: [jiraProjects('ALI')] });
    await expect(decideConnectScope('jira', TOKENS.jira, bad.ctx)).rejects.toThrow(/NOPE/);
  });

  it('not interactive, nothing flagged or stored: the cited keys the token can see become the scope, and the line says so', async () => {
    const s = setup({ cited: ['ALI', 'OPS', 'GONE'], table: [jiraProjects('ALI', 'OPS')] });
    const d = await decideConnectScope('jira', TOKENS.jira, s.ctx);
    expect(d).toMatchObject({ scope: 'team', extras: { projects: ['ALI', 'OPS'] } });
    expect(s.said.join('\n')).toContain('everyone in Jira projects ALI, OPS');
  });

  it('not interactive and no cited key: yours, and the line says how to widen (two reasons: none cited, none visible)', async () => {
    const none = setup({ cited: [], table: [jiraProjects('ALI')] });
    expect(await decideConnectScope('jira', TOKENS.jira, none.ctx)).toMatchObject({ scope: 'yours' });
    expect(none.said.join('\n')).toContain('align connect --source jira --projects KEYS');
    expect(none.deps.calls).toHaveLength(0);
    const hidden = setup({ cited: ['GONE'], table: [jiraProjects('ALI')] });
    expect(await decideConnectScope('jira', TOKENS.jira, hidden.ctx)).toMatchObject({ scope: 'yours' });
    expect(hidden.said.join('\n')).toContain('--projects KEYS');
  });

  it('not interactive with a stored team choice: used as it is, with no listing', async () => {
    const store = memStore({ scopes: { jira: { kind: 'team', values: ['BETA'], labels: ['BETA'] } } });
    const s = setup({ cited: ['ALI'], store });
    expect(await decideConnectScope('jira', TOKENS.jira, s.ctx)).toMatchObject({ scope: 'team', extras: { projects: ['BETA'] } });
    expect(s.deps.calls).toHaveLength(0);
  });

  it('a list that cannot be read never blocks the connect: yours, with the reason (interactive and not)', async () => {
    for (const interactive of [true, false]) {
      const s = setup({ interactive, cited: ['ALI'], table: [[/project\/search/, { status: 500 }]] });
      const d = await decideConnectScope('jira', TOKENS.jira, s.ctx);
      expect(d.scope).toBe('yours');
      expect(s.said.join('\n')).toContain('Jira answered 500');
      expect(s.said.join('\n')).toContain('--projects KEYS');
    }
  });
});

describe('an explicit yours is remembered', () => {
  it('not interactive: stored yours beats the cited keys, with no listing; interactive preselects nothing (two surfaces)', async () => {
    const store = () => memStore({ scopes: { jira: { kind: 'yours' } } });
    const quiet = setup({ cited: ['ALI'], table: [jiraProjects('ALI')], store: store() });
    expect(await decideConnectScope('jira', TOKENS.jira, quiet.ctx)).toMatchObject({ scope: 'yours' });
    expect(quiet.deps.calls).toHaveLength(0);
    const asked = setup({ interactive: true, cited: ['ALI'], table: [jiraProjects('ALI')], store: store() });
    await decideConnectScope('jira', TOKENS.jira, asked.ctx);
    expect(asked.asked[0]!.initial).toEqual([]);
  });

  it('GitHub: a damaged-looking record is already yours, so a repo folder does not widen it', async () => {
    const s = setup({ cwdRepo: 'o/r', table: [SEARCH], store: memStore({ scopes: { github: { kind: 'yours' } } }) });
    expect(await decideConnectScope('github', TOKENS.github, s.ctx)).toMatchObject({ scope: 'yours' });
    expect(s.deps.calls).toHaveLength(0);
  });
});

describe('Linear', () => {
  it('interactive: team keys are offered, the cited ones preselected, and the choice reaches the fetcher as ids', async () => {
    const s = setup({ interactive: true, cited: ['ENG', 'GONE'], table: [teams('ENG', 'OPS')], picks: ['ENG'] });
    const d = await decideConnectScope('linear', TOKENS.linear, s.ctx);
    expect(s.asked[0]!.options.map((x) => x.value)).toEqual(['ENG', 'OPS']);
    expect(s.asked[0]!.initial).toEqual(['ENG']);
    expect(d).toMatchObject({ scope: 'team', extras: { teams: ['id-ENG'] }, label: "everyone's items in Linear team ENG" });
  });

  it('not interactive: --teams, else the cited keys the token can see, else yours (three cases)', async () => {
    const flagged = setup({ flags: { teams: 'ops' }, table: [teams('ENG', 'OPS')] });
    expect(await decideConnectScope('linear', TOKENS.linear, flagged.ctx)).toMatchObject({ extras: { teams: ['id-OPS'] } });
    const cited = setup({ cited: ['ENG'], table: [teams('ENG')] });
    expect(await decideConnectScope('linear', TOKENS.linear, cited.ctx)).toMatchObject({ scope: 'team', extras: { teams: ['id-ENG'] } });
    const none = setup({ table: [teams('ENG')] });
    expect(await decideConnectScope('linear', TOKENS.linear, none.ctx)).toMatchObject({ scope: 'yours' });
    expect(none.said.join('\n')).toContain('--teams KEYS');
  });
});

describe('Confluence', () => {
  it('interactive: the picker requires at least one space; picked spaces are the scope', async () => {
    const s = setup({ interactive: true, table: [spaces('ENG', 'OPS')], picks: ['OPS', 'ENG'] });
    const d = await decideConnectScope('confluence', TOKENS.confluence, s.ctx);
    expect(s.asked[0]!.required).toBe(true);
    expect(d).toMatchObject({ scope: 'team', extras: { spaces: ['ENG', 'OPS'] } });
  });

  it('interactive but nothing picked, or cancelled: refused with the command, before any fetch (two answers)', async () => {
    for (const picks of [[], null]) {
      const s = setup({ interactive: true, table: [spaces('ENG')], picks });
      await expect(decideConnectScope('confluence', TOKENS.confluence, s.ctx)).rejects.toThrow(/align connect --source confluence --spaces/);
    }
  });

  it('not interactive: --spaces is used; a stored choice is used; neither is refused with the command (three cases)', async () => {
    const flagged = setup({ flags: { spaces: 'ENG' }, table: [spaces('ENG')] });
    expect(await decideConnectScope('confluence', TOKENS.confluence, flagged.ctx)).toMatchObject({ extras: { spaces: ['ENG'] } });
    const stored = setup({ store: memStore({ scopes: { confluence: { kind: 'team', values: ['OPS'], labels: ['OPS'] } } }) });
    expect(await decideConnectScope('confluence', TOKENS.confluence, stored.ctx)).toMatchObject({ extras: { spaces: ['OPS'] } });
    const none = setup();
    await expect(decideConnectScope('confluence', TOKENS.confluence, none.ctx)).rejects.toThrow(/align connect --source confluence --spaces ENG,OPS/);
    expect(none.deps.calls).toHaveLength(0);
  });

  it('a list that cannot be read is a refusal too (Confluence has no yours to fall back to), with the reason', async () => {
    const s = setup({ interactive: true, table: [[/wiki\/api\/v2\/spaces/, { status: 401 }]] });
    await expect(decideConnectScope('confluence', TOKENS.confluence, s.ctx)).rejects.toThrow(/refused the saved token/);
  });
});

describe('GitLab, Zoom and the sources with nothing to pick', () => {
  it('GitLab: the project from the remote when the token can see it; --gitlab-project; the cannot-see line (three cases)', async () => {
    const seen = setup({ cwdGitlab: 'g/p', table: [[/api\/v4\/projects/, { status: 200 }]] });
    expect(await decideConnectScope('gitlab', TOKENS.gitlab, seen.ctx)).toMatchObject({ scope: 'team', extras: { projectId: 'g/p' } });
    const flagged = setup({ flags: { gitlabProject: '12' }, table: [[/api\/v4\/projects/, { status: 200 }]] });
    expect(await decideConnectScope('gitlab', TOKENS.gitlab, flagged.ctx)).toMatchObject({ extras: { projectId: '12' } });
    const hidden = setup({ cwdGitlab: 'g/p', table: [[/projects/, { status: 404 }]] });
    expect(await decideConnectScope('gitlab', TOKENS.gitlab, hidden.ctx)).toMatchObject({ scope: 'yours' });
    expect(hidden.said.join('\n')).toContain('cannot see g/p');
  });

  it('Zoom says it is only yours and why; Slack, Notion and Teams say nothing and add nothing', async () => {
    const z = setup();
    expect(await decideConnectScope('zoom', { token: 't' }, z.ctx)).toMatchObject({ scope: 'yours', extras: {} });
    expect(z.said.join('\n')).toContain('Zoom reads only your own cloud recordings');
    expect(z.said.join('\n')).toContain('admin');
    for (const id of ['slack', 'notion', 'teams']) {
      const s = setup();
      expect(await decideConnectScope(id, { token: 't' }, s.ctx), id).toMatchObject({ extras: {} });
      expect(s.said, id).toEqual([]);
    }
  });
});

describe('fetchUnderScope', () => {
  const report = { scanned: 0, skips: [] as never[] };
  const source = (fetch: ReturnType<typeof vi.fn>): { id: string; fetch: ReturnType<typeof vi.fn> } => ({ id: 'jira', fetch });

  it('says the disclosure BEFORE the fetch, hands the fetch the scope, writes the choice only AFTER it succeeded, and names whose items were read', async () => {
    const events: string[] = [];
    const s = setup({ flags: { projects: 'ALI' }, table: [jiraProjects('ALI')] });
    s.ctx.say = (l) => events.push(`say:${l.slice(0, 9)}`);
    const fetch = vi.fn(async () => { events.push('fetch'); expect(s.deps.store.scopes['jira']).toBeUndefined(); return { items: [], report: { ...report } }; });
    const r = await fetchUnderScope(source(fetch), TOKENS.jira, undefined, s.ctx);
    expect(events).toEqual(['say:Importing', 'fetch']);
    expect(fetch).toHaveBeenCalledWith(TOKENS.jira, undefined, { resolved: true, projects: ['ALI'] });
    expect(s.deps.store.scopes['jira']).toEqual({ kind: 'team', values: ['ALI'], labels: ['ALI'] });
    expect(r.report.scopeNote).toBe("everyone's items in Jira project ALI, as far as your token can see");
    expect(readRows(dbPath, 'jira').find((x) => x.scope_key === 'jira:ALI')).toMatchObject({ scope: 'team', changed_via: 'cli', changed_by_agent: null });
  });

  it('the spinner starts AFTER the questions and the disclosure, before the fetch, and also before a refusal is thrown', async () => {
    const events: string[] = [];
    const s = setup({ interactive: true, table: [jiraProjects('ALI')], picks: ['ALI'] });
    s.ctx.prompts = { multiselect: async () => { events.push('ask'); return ['ALI']; } };
    s.ctx.say = () => { events.push('say'); };
    const fetch = vi.fn(async () => { events.push('fetch'); return { items: [], report: { ...report } }; });
    await fetchUnderScope(source(fetch), TOKENS.jira, undefined, s.ctx, () => events.push('spinner'));
    expect(events).toEqual(['ask', 'say', 'spinner', 'fetch']);
    const refused: string[] = [];
    const none = setup({ table: [] });
    await expect(fetchUnderScope({ id: 'confluence', fetch: vi.fn() }, TOKENS.confluence, undefined, none.ctx, () => refused.push('spinner'))).rejects.toThrow(/--spaces/);
    expect(refused).toEqual(['spinner']);
  });

  it('a failed fetch writes nothing', async () => {
    const s = setup({ flags: { projects: 'ALI' }, table: [jiraProjects('ALI')] });
    await expect(fetchUnderScope(source(vi.fn(async () => { throw new Error('boom'); })), TOKENS.jira, undefined, s.ctx)).rejects.toThrow('boom');
    expect(s.deps.store.scopes['jira']).toBeUndefined();
    expect(readRows(dbPath, 'jira')).toEqual([]);
  });

  it('keeps a scope note the fetcher already set (GitHub names the repo itself)', async () => {
    const s = setup({ cwdRepo: 'o/r', table: [SEARCH] });
    const fetch = vi.fn(async () => ({ items: [], report: { ...report, scopeNote: "everyone's PRs and issues in o/r, as far as your token can see" } }));
    const r = await fetchUnderScope({ id: 'github', fetch }, TOKENS.github, undefined, s.ctx);
    expect(r.report.scopeNote).toBe("everyone's PRs and issues in o/r, as far as your token can see");
  });

  it('a yours scope adds no scope note', async () => {
    const s = setup();
    const r = await fetchUnderScope({ id: 'slack', fetch: vi.fn(async () => ({ items: [], report: { ...report } })) }, { token: 't' }, undefined, s.ctx);
    expect(r.report.scopeNote).toBeUndefined();
  });
});

describe('checkScopeFlags', () => {
  const check = checkScopeFlags;

  it('a scope flag needs --source', () => {
    expect(check(undefined, { projects: 'ALI' })).toContain('--source');
    expect(check(undefined, { scope: 'yours' })).toContain('--source');
    expect(check(undefined, {})).toBeUndefined();
  });

  it('each value flag belongs to one source (two mismatches, five matches)', () => {
    expect(check('jira', { spaces: 'ENG' })).toContain('--spaces is for Confluence');
    expect(check('github', { projects: 'ALI' })).toContain('--projects is for Jira');
    expect(check('github', { repo: 'o/r' })).toBeUndefined();
    expect(check('jira', { projects: 'ALI' })).toBeUndefined();
    expect(check('linear', { teams: 'ENG' })).toBeUndefined();
    expect(check('gitlab', { gitlabProject: 'g/p' })).toBeUndefined();
    expect(check('confluence', { spaces: 'ENG' })).toBeUndefined();
  });

  it('--scope takes yours or team; yours with a value contradicts; team needs a value except where the folder supplies it', () => {
    expect(check('jira', { scope: 'everyone' })).toContain('--scope takes yours or team');
    expect(check('jira', { scope: 'yours', projects: 'ALI' })).toContain('either');
    expect(check('jira', { scope: 'team' })).toContain('--projects');
    expect(check('github', { scope: 'team' })).toBeUndefined();
    expect(check('gitlab', { scope: 'team' })).toBeUndefined();
    expect(check('jira', { scope: 'team', projects: 'ALI' })).toBeUndefined();
  });

  it('a source with no scope to set refuses the flags by name (Zoom says why)', () => {
    expect(check('zoom', { scope: 'team' })).toContain('only your own');
    expect(check('slack', { scope: 'yours' })).toContain('channels your token is in');
  });
});

describe('one choice, three surfaces', () => {
  const report = { scanned: 0, skips: [] as never[] };

  it('a choice made at connect is what the next sync reads (background too), under the key its row carries', async () => {
    const s = setup({ flags: { projects: 'ALI' }, table: [jiraProjects('ALI')] });
    await fetchUnderScope({ id: 'jira', fetch: vi.fn(async () => ({ items: [], report: { ...report } })) }, TOKENS.jira, undefined, s.ctx);
    for (const trigger of ['cli', 'background'] as const) {
      const sc = await scopeOf('jira', { trigger }, s.deps);
      expect(sc).toMatchObject({ scope: 'team', scopeKey: 'jira:ALI', extras: { projects: ['ALI'] } });
    }
    expect(readRows(dbPath, 'jira').map((r) => r.scope_key)).toContain('jira:ALI');
  });

  it('a choice made by an agent through align_scope is what connect then keeps (non-interactive, nothing flagged) and what sync reads', async () => {
    const s = setup({ table: [jiraProjects('ALI', 'OPS')] });
    const env = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: dbPath } as never;
    await runScopeTool({ action: 'set', source: 'jira', projects: ['OPS'] }, env, s.deps, { agent: 'claude-code' });
    const d = await decideConnectScope('jira', TOKENS.jira, s.ctx);
    expect(d).toMatchObject({ scope: 'team', extras: { projects: ['OPS'] } });
    expect(await scopeOf('jira', { trigger: 'background' }, s.deps)).toMatchObject({ scopeKey: 'jira:OPS' });
    // The disclosure the agent relayed was not the person seeing it at a terminal: connect still tells them.
    expect(s.said.join('\n')).toContain('everyone in Jira project OPS');
  });

  it('narrowing back from connect (--scope yours) is what sync reads next, and the team row and its items stay', async () => {
    const store = memStore({ scopes: { jira: { kind: 'team', values: ['OPS'], labels: ['OPS'] } } });
    const s = setup({ flags: { scope: 'yours' }, store });
    await fetchUnderScope({ id: 'jira', fetch: vi.fn(async () => ({ items: [], report: { ...report } })) }, TOKENS.jira, undefined, s.ctx);
    expect(await scopeOf('jira', { trigger: 'cli' }, s.deps)).toMatchObject({ scope: 'yours', scopeKey: 'yours' });
    expect(readRows(dbPath, 'jira').find((r) => r.scope_key === 'yours')).toBeDefined();
  });
});

describe('connectScopeCtx (the production wiring)', () => {
  it('carries the flags, the graph path and the interactive/quiet switches, reads cited keys from the graph, and says lines through clack', async () => {
    const info = vi.fn();
    vi.doMock('@clack/prompts', () => ({ log: { info }, multiselect: vi.fn(), isCancel: () => false }));
    vi.resetModules();
    const { connectScopeCtx } = await import('../lib/scope-connect.js');
    const config = { getConnectorScope: () => null, getConnectorFields: () => null } as never;
    const ctx = connectScopeCtx({ config, dbPath, interactive: true, quiet: false, flags: { projects: 'ALI' } });
    expect(ctx).toMatchObject({ interactive: true, quiet: false, flags: { projects: 'ALI' } });
    expect(ctx.deps.dbPath).toBe(dbPath);
    expect(ctx.citedKeys()).toEqual([]);
    ctx.say('hello');
    expect(info).toHaveBeenCalledWith('hello');
    expect(connectScopeCtx({ config, dbPath: undefined, interactive: false, quiet: true }).citedKeys()).toEqual([]);
    vi.doUnmock('@clack/prompts');
  });
});
