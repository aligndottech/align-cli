import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { resolveScope, ScopeRefusal, setScope, viewScopes } from '../lib/scope.js';
import { beginRun, readRows } from '../lib/sync/sync-state.js';
import { jiraProjects, makeDeps, memStore, type Route, TOKEN } from './helpers/scope-deps.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * L4 Test List (which scope is in force, and changing it):
 * resolveScope
 * - GitHub inside a repo the token can see reads the whole repo (team); outside a repo, or with an explicit "yours", it is yours.
 * - A repo the token cannot see (P0's 422) falls back to yours and says so with the reconnect command; a probe that could not answer
 *   proceeds as team and lets the fetch report.
 * - A chosen scope (stored) wins over the folder, makes no probe, and is read by a background run as chosen.
 * - Auto-detected team scope needs the disclosure to have been shown before a BACKGROUND run reads it.
 * - Jira, Linear and Confluence read the stored choice; Jira and Linear default to yours; Confluence with no spaces is blocked.
 * - GitLab takes the project from the remote, like GitHub. Zoom, Slack, Notion and Teams keep the `yours` key (existing rows stay valid).
 * - The disclosure is returned for a foreground team read not yet disclosed, never twice, never in the background.
 * setScope
 * - Needs a connected source; Zoom and the read-everything sources refuse by name; values are checked against what the token can see
 *   (and never echoed when invalid); nothing is stored on any refusal.
 * - A new scope gets its own source_sync row with the source's window and no watermark; an existing scope row is reused untouched;
 *   the previous scope's row and every imported item stay.
 * - The change is attributed (cli, or mcp plus the agent id). The text states the cost of widening and carries the disclosure.
 * viewScopes
 * - Connected sources only; GitHub shows what a sync here would read; nothing secret.
 */
const NOW = new Date('2026-10-10T12:00:00.000Z');
const WINDOW = '2026-04-12T12:00:00.000Z';

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l4-scope-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalGatewayClient(dbPath).close();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const deps = (over: Parameters<typeof makeDeps>[1] = {}): ReturnType<typeof makeDeps> => makeDeps(dbPath, over);
const SEARCH = /api\.github\.com\/search\/issues/;

describe('resolveScope: GitHub', () => {
  it('inside a repo the token can see: team on that repo, key repo:o/r, no note', async () => {
    const d = deps({ cwdRepo: async () => 'o/r', table: [[SEARCH, { status: 200 }]] });
    const r = await resolveScope('github', d, { foreground: true });
    expect(r).toMatchObject({ scope: 'team', scopeKey: 'repo:o/r', repo: 'o/r', origin: 'detected', label: "everyone's items in o/r" });
    expect(r.note).toBeUndefined();
    expect(d.calls).toHaveLength(1);
  });

  it('inside a repo the token cannot see (422): yours, key yours, and the line says so with the reconnect command', async () => {
    const d = deps({ cwdRepo: async () => 'aligndottech/align-stack', table: [[SEARCH, { status: 422 }]] });
    const r = await resolveScope('github', d, { foreground: true });
    expect(r).toMatchObject({ scope: 'yours', scopeKey: 'yours', origin: 'default' });
    expect(r.repo).toBeUndefined();
    expect(r.note).toBe('Your GitHub token cannot see aligndottech/align-stack, so only items you are involved in were imported. Reconnect with repo access: align connect github');
    expect(r.disclosure).toBeUndefined();
  });

  it('a probe that cannot answer (500, offline) proceeds as team and lets the fetch report', async () => {
    for (const hit of [{ status: 500 }, new Error('offline')]) {
      const d = deps({ cwdRepo: async () => 'o/r', table: [[SEARCH, hit]] });
      expect(await resolveScope('github', d, { foreground: true })).toMatchObject({ scope: 'team', repo: 'o/r' });
    }
  });

  it('outside a GitHub repo: yours, and the note says so and how to read a repo', async () => {
    const r = await resolveScope('github', deps(), { foreground: true });
    expect(r).toMatchObject({ scope: 'yours', scopeKey: 'yours', origin: 'default' });
    expect(r.note).toContain('not a GitHub repo');
    expect(r.note).toContain('align connect --source github --repo owner/repo');
  });

  it('a stored "yours" wins over the folder and makes no probe', async () => {
    const d = deps({ store: memStore({ scopes: { github: { kind: 'yours' } } }), cwdRepo: async () => 'o/r', table: [[SEARCH, { status: 200 }]] });
    expect(await resolveScope('github', d, { foreground: true })).toMatchObject({ scope: 'yours', origin: 'chosen' });
    expect(d.calls).toHaveLength(0);
  });

  it('a stored repo wins over the folder, makes no probe, and a background run reads it as chosen (two examples)', async () => {
    const store = memStore({ scopes: { github: { kind: 'team', values: ['x/y'], labels: ['x/y'] } } });
    const d = deps({ store, cwdRepo: async () => 'o/r', table: [[SEARCH, { status: 422 }]] });
    expect(await resolveScope('github', d, { foreground: true })).toMatchObject({ scope: 'team', scopeKey: 'repo:x/y', repo: 'x/y', origin: 'chosen' });
    expect(await resolveScope('github', d, { foreground: false })).toMatchObject({ scope: 'team', repo: 'x/y', origin: 'chosen' });
    expect(d.calls).toHaveLength(0);
  });

  it('a BACKGROUND run reads an auto-detected repo as team only after the disclosure was shown (both sides)', async () => {
    const before = deps({ cwdRepo: async () => 'o/r', table: [[SEARCH, { status: 200 }]] });
    expect(await resolveScope('github', before, { foreground: false })).toMatchObject({ scope: 'yours', scopeKey: 'yours' });
    expect(before.calls).toHaveLength(0);
    const after = deps({ store: memStore({ disclosed: ['github'] }), cwdRepo: async () => 'o/r', table: [[SEARCH, { status: 200 }]] });
    expect(await resolveScope('github', after, { foreground: false })).toMatchObject({ scope: 'team', repo: 'o/r' });
  });

  it('the disclosure comes with a foreground team read that was not yet disclosed, and not otherwise (three cases)', async () => {
    const fresh = deps({ cwdRepo: async () => 'o/r', table: [[SEARCH, { status: 200 }]] });
    const r = await resolveScope('github', fresh, { foreground: true });
    expect(r.disclosure).toContain('Importing items from everyone in o/r that your token can read. They stay on this machine.');
    const told = deps({ store: memStore({ disclosed: ['github'] }), cwdRepo: async () => 'o/r', table: [[SEARCH, { status: 200 }]] });
    expect((await resolveScope('github', told, { foreground: true })).disclosure).toBeUndefined();
    const yours = deps();
    expect((await resolveScope('github', yours, { foreground: true })).disclosure).toBeUndefined();
  });
});

describe('resolveScope: review additions', () => {
  it('a team read in the BACKGROUND carries no disclosure, even for a stored choice (the line is for a person at a terminal)', async () => {
    const store = memStore({ scopes: { linear: { kind: 'team', values: ['id-9'], labels: ['ENG'] } } });
    expect((await resolveScope('linear', deps({ store }), { foreground: false })).disclosure).toBeUndefined();
    expect((await resolveScope('linear', deps({ store }), { foreground: true })).disclosure).toContain('Linear team ENG');
  });

  it('GitLab with a token saved for a self-managed host does not read the gitlab.com folder as a project there (both sides)', async () => {
    const table: Array<[RegExp, { status: number }]> = [[/projects/, { status: 200 }]];
    const own = deps({ cwdGitlabProject: async () => 'g/p', table });
    expect((await resolveScope('gitlab', own, { foreground: true })).scope).toBe('team');
    const store = memStore();
    const f = store.fields;
    store.fields = (s) => (s === 'gitlab' ? { token: 'x', domain: 'git.acme.io' } : f(s));
    const other = deps({ store, cwdGitlabProject: async () => 'g/p', table });
    expect((await resolveScope('gitlab', other, { foreground: true })).scope).toBe('yours');
    expect(other.calls).toHaveLength(0);
  });
});

describe('resolveScope: the other sources', () => {
  it('Jira reads the stored projects as team with the option the fetcher takes; with none it is yours and says how to widen', async () => {
    const store = memStore({ scopes: { jira: { kind: 'team', values: ['OPS', 'ALI'], labels: ['OPS', 'ALI'] } } });
    const r = await resolveScope('jira', deps({ store }), { foreground: true });
    expect(r).toMatchObject({ scope: 'team', scopeKey: 'jira:ALI,OPS', extras: { projects: ['OPS', 'ALI'] }, origin: 'chosen' });
    expect(r.disclosure).toContain('Jira projects ALI, OPS');
    const none = await resolveScope('jira', deps(), { foreground: true });
    expect(none).toMatchObject({ scope: 'yours', scopeKey: 'yours', extras: {} });
    expect(none.note).toContain('align connect --source jira --projects');
  });

  it('Linear keeps ids for the fetcher and keys for the key and the words', async () => {
    const store = memStore({ scopes: { linear: { kind: 'team', values: ['id-9'], labels: ['ENG'] } } });
    const r = await resolveScope('linear', deps({ store }), { foreground: false });
    expect(r).toMatchObject({ scope: 'team', scopeKey: 'linear:ENG', extras: { teams: ['id-9'] } });
    expect(r.label).toBe("everyone's items in Linear team ENG");
  });

  it('Confluence reads only the spaces chosen; with none (or "yours") it is blocked and names the command (two examples)', async () => {
    const store = memStore({ scopes: { confluence: { kind: 'team', values: ['ENG'], labels: ['ENG'] } } });
    expect(await resolveScope('confluence', deps({ store }), { foreground: false })).toMatchObject({ scope: 'team', scopeKey: 'confluence:ENG', extras: { spaces: ['ENG'] } });
    for (const s of [memStore(), memStore({ scopes: { confluence: { kind: 'yours' } } })]) {
      const r = await resolveScope('confluence', deps({ store: s }), { foreground: true });
      expect(r.blocked).toContain('align connect --source confluence --spaces');
    }
  });

  it('GitLab takes the project from the remote when the token can see it, and says so when it cannot', async () => {
    const seen = deps({ cwdGitlabProject: async () => 'g/p', table: [[/gitlab\.com\/api\/v4\/projects\/g%2Fp/, { status: 200 }]] });
    expect(await resolveScope('gitlab', seen, { foreground: true })).toMatchObject({ scope: 'team', scopeKey: 'gitlab:g/p', extras: { projectId: 'g/p' }, origin: 'detected' });
    const hidden = deps({ cwdGitlabProject: async () => 'g/p', table: [[/projects/, { status: 404 }]] });
    const r = await resolveScope('gitlab', hidden, { foreground: true });
    expect(r).toMatchObject({ scope: 'yours', scopeKey: 'yours' });
    expect(r.note).toContain('cannot see g/p');
    expect((await resolveScope('gitlab', deps(), { foreground: true })).scope).toBe('yours');
  });

  it('Zoom, Slack, Notion and Teams keep the yours key, so rows written before L4 stay valid', async () => {
    for (const s of ['zoom', 'slack', 'notion', 'teams']) {
      expect(await resolveScope(s, deps(), { foreground: true }), s).toMatchObject({ scope: 'yours', scopeKey: 'yours' });
    }
  });
});

function seedRows(over: { window?: string | null; withTeam?: { key: string; highWater: string } } = {}): void {
  beginRun(dbPath, { source: 'jira', scopeKey: 'yours', scope: 'yours' }, over.window === undefined ? WINDOW : over.window, NOW.toISOString());
  if (over.withTeam) {
    beginRun(dbPath, { source: 'jira', scopeKey: over.withTeam.key, scope: 'team' }, WINDOW, NOW.toISOString());
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE source_sync SET high_water = ? WHERE source_id = ? AND scope_key = ?').run(over.withTeam.highWater, 'jira', over.withTeam.key);
    raw.close();
  }
}

describe('setScope', () => {
  it('Jira team: stored, a new source_sync row with the source window and no watermark, attributed to the agent', async () => {
    seedRows();
    const d = deps({ table: [jiraProjects('ALI', 'OPS')] });
    const r = await setScope(d, 'jira', { scope: 'team', values: ['ops'] }, { via: 'mcp', agent: 'claude-code' });
    expect(d.store.scopes['jira']).toEqual({ kind: 'team', values: ['OPS'], labels: ['OPS'] });
    const row = readRows(dbPath, 'jira').find((x) => x.scope_key === 'jira:OPS')!;
    expect(row).toMatchObject({ scope: 'team', window_since: WINDOW, high_water: null, changed_via: 'mcp', changed_by_agent: 'claude-code' });
    expect(r).toMatchObject({ scope: 'team', scopeKey: 'jira:OPS', newRow: true });
    expect(r.disclosure).toContain('everyone in Jira project OPS');
  });

  it('the same change from the CLI is attributed to cli with no agent', async () => {
    seedRows();
    await setScope(deps({ table: [jiraProjects('ALI')] }), 'jira', { scope: 'team', values: 'ALI' }, { via: 'cli' });
    expect(readRows(dbPath, 'jira').find((x) => x.scope_key === 'jira:ALI')).toMatchObject({ changed_via: 'cli', changed_by_agent: null });
  });

  it('a window of "all" (NULL) is inherited as "all", not replaced by a default', async () => {
    seedRows({ window: null });
    await setScope(deps({ table: [jiraProjects('ALI')] }), 'jira', { scope: 'team', values: ['ALI'] }, { via: 'cli' });
    expect(readRows(dbPath, 'jira').find((x) => x.scope_key === 'jira:ALI')!.window_since).toBeNull();
  });

  it('with no earlier row at all, the new scope starts at the default window', async () => {
    await setScope(deps({ table: [jiraProjects('ALI')] }), 'jira', { scope: 'team', values: ['ALI'] }, { via: 'cli' });
    expect(readRows(dbPath, 'jira').find((x) => x.scope_key === 'jira:ALI')!.window_since).toBe('2026-04-13T12:00:00.000Z');
  });

  it('the earlier scope row is left exactly as it was, and no item is deleted', async () => {
    const db = createLocalDb(dbPath);
    for (let i = 0; i < 3; i++) db.insertDecision({ title: `T${i}`, summary: `S${i}`, sourceUrl: `https://acme.atlassian.net/browse/ALI-${i}`, platform: 'jira' });
    db.close();
    seedRows();
    const before = readRows(dbPath, 'jira').find((x) => x.scope_key === 'yours')!;
    await setScope(deps({ table: [jiraProjects('OPS')] }), 'jira', { scope: 'team', values: ['OPS'] }, { via: 'cli' });
    expect(readRows(dbPath, 'jira').find((x) => x.scope_key === 'yours')).toEqual(before);
    const raw = new DatabaseSync(dbPath);
    expect((raw.prepare('SELECT count(*) AS n FROM decisions').get() as { n: number }).n).toBe(3);
    raw.close();
  });

  it('switching back to a scope read before reuses its row and its watermark (cost text says catch up, not re-read)', async () => {
    seedRows({ withTeam: { key: 'jira:OPS', highWater: '2026-10-01T00:00:00.000Z' } });
    const r = await setScope(deps({ table: [jiraProjects('OPS')] }), 'jira', { scope: 'team', values: ['OPS'] }, { via: 'cli' });
    expect(r.newRow).toBe(false);
    expect(readRows(dbPath, 'jira').find((x) => x.scope_key === 'jira:OPS')!.high_water).toBe('2026-10-01T00:00:00.000Z');
    expect(r.text).toContain('read before');
    expect(r.text).toContain('catches up since 2026-10-01');
  });

  it('widening to a new scope says plainly that it re-reads the window and that nothing already imported is deleted', async () => {
    seedRows();
    const r = await setScope(deps({ table: [jiraProjects('OPS')] }), 'jira', { scope: 'team', values: ['OPS'] }, { via: 'cli' });
    expect(r.text).toContain('re-reads Jira back to 2026-04-12');
    expect(r.text).toContain('Nothing already imported is deleted');
  });

  it('back to yours replaces the stored team choice with an explicit yours (Jira) and keeps the team row and its data', async () => {
    seedRows({ withTeam: { key: 'jira:OPS', highWater: '2026-10-01T00:00:00.000Z' } });
    const store = memStore({ scopes: { jira: { kind: 'team', values: ['OPS'], labels: ['OPS'] } } });
    const r = await setScope(deps({ store }), 'jira', { scope: 'yours' }, { via: 'mcp', agent: 'codex' });
    expect(store.scopes['jira']).toEqual({ kind: 'yours' });
    expect(r).toMatchObject({ scope: 'yours', scopeKey: 'yours' });
    expect(readRows(dbPath, 'jira').map((x) => x.scope_key)).toEqual(['jira:OPS', 'yours']);
    expect(r.text).toContain('stay in your graph');
  });

  it('GitHub yours is stored explicitly (so the folder cannot widen it again); team is checked against what the token can see', async () => {
    const store = memStore();
    await setScope(deps({ store }), 'github', { scope: 'yours' }, { via: 'cli' });
    expect(store.scopes['github']).toEqual({ kind: 'yours' });
    const ok = deps({ table: [[SEARCH, { status: 200 }]] });
    const r = await setScope(ok, 'github', { scope: 'team', values: ['o/r'] }, { via: 'cli' });
    expect(ok.store.scopes['github']).toEqual({ kind: 'team', values: ['o/r'], labels: ['o/r'] });
    expect(r.scopeKey).toBe('repo:o/r');
  });

  it('GitHub: a repo the token cannot see is refused with the reconnect line; one it could not check is refused too; nothing is stored', async () => {
    for (const [hit, kind, text] of [[{ status: 422 }, 'invisible', 'cannot see o/r'], [{ status: 500 }, 'unverified', 'could not check']] as const) {
      const d = deps({ table: [[SEARCH, hit]] });
      const err = await setScope(d, 'github', { scope: 'team', values: 'o/r' }, { via: 'cli' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ScopeRefusal);
      expect((err as ScopeRefusal).kind).toBe(kind);
      expect((err as ScopeRefusal).message).toContain(text);
      expect(d.store.scopes['github']).toBeUndefined();
    }
  });

  it('refuses an unconnected source with the command to run, and stores nothing', async () => {
    const d = deps({ store: memStore({ connected: ['github'] }) });
    const err = await setScope(d, 'jira', { scope: 'team', values: ['ALI'] }, { via: 'mcp', agent: 'x' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(err.kind).toBe('not_connected');
    expect(err.message).toContain('align connect jira');
    expect(d.store.scopes['jira']).toBeUndefined();
    expect(d.calls).toHaveLength(0);
  });

  it('Zoom says it is only yours; Slack, Notion and Teams say they read everything the token can see; an unknown source is refused (three examples)', async () => {
    const z = await setScope(deps(), 'zoom', { scope: 'team', values: ['x'] }, { via: 'cli' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(z.kind).toBe('fixed');
    expect(z.message).toContain('only your own');
    const s = await setScope(deps(), 'slack', { scope: 'yours' }, { via: 'cli' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(s.message).toContain('channels your token is in');
    const u = await setScope(deps(), 'myspace', { scope: 'yours' }, { via: 'cli' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(u.kind).toBe('unknown_source');
  });

  it('an invalid value is refused without being printed, and nothing is requested or stored', async () => {
    const d = deps({ table: [jiraProjects('ALI')] });
    const err = await setScope(d, 'jira', { scope: 'team', values: ['ghp_SECRETVALUE0123456789'] }, { via: 'mcp', agent: 'a' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(err.kind).toBe('invalid');
    expect(err.message).not.toContain('SECRETVALUE');
    expect(d.calls).toHaveLength(0);
    expect(d.store.scopes['jira']).toBeUndefined();
  });

  it('a project the token cannot see is refused by key, and a lookup the vendor refused says to reconnect (two failures)', async () => {
    const d = deps({ table: [jiraProjects('ALI')] });
    const err = await setScope(d, 'jira', { scope: 'team', values: ['ALI', 'NOPE'] }, { via: 'cli' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(err.kind).toBe('not_visible');
    expect(err.message).toContain('NOPE');
    expect(err.message).not.toContain('ALI,');
    expect(d.store.scopes['jira']).toBeUndefined();
    const refused = deps({ table: [[/project\/search/, { status: 401 }]] });
    const e2 = await setScope(refused, 'jira', { scope: 'team', values: ['ALI'] }, { via: 'cli' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(e2.kind).toBe('lookup');
    expect(e2.message).toContain('align connect jira');
    expect(refused.store.scopes['jira']).toBeUndefined();
  });

  it('Linear: team keys are resolved to ids for the fetcher and kept as keys for people; an unknown team is refused', async () => {
    const teams: Route = [/api\.linear\.app/, { body: { data: { teams: { nodes: [{ id: 'id-1', key: 'ENG', name: 'Eng' }, { id: 'id-2', key: 'OPS', name: 'Ops' }] } } } }];
    const d = deps({ table: [teams] });
    await setScope(d, 'linear', { scope: 'team', values: ['eng'] }, { via: 'cli' });
    expect(d.store.scopes['linear']).toEqual({ kind: 'team', values: ['id-1'], labels: ['ENG'] });
    const err = await setScope(deps({ table: [teams] }), 'linear', { scope: 'team', values: ['NOPE'] }, { via: 'cli' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(err.kind).toBe('not_visible');
  });

  it('Confluence: spaces are checked against the token; "yours" is refused because there is no such scope', async () => {
    const spaces: Route = [/wiki\/api\/v2\/spaces/, { body: { results: [{ key: 'ENG', name: 'E' }, { key: 'OPS', name: 'O' }] } }];
    const d = deps({ table: [spaces] });
    await setScope(d, 'confluence', { scope: 'team', values: ['OPS', 'ENG'] }, { via: 'cli' });
    expect(d.store.scopes['confluence']).toEqual({ kind: 'team', values: ['ENG', 'OPS'], labels: ['ENG', 'OPS'] });
    const err = await setScope(deps(), 'confluence', { scope: 'yours' }, { via: 'cli' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(err.kind).toBe('no_yours');
    expect(err.message).toContain('--spaces');
  });

  it('GitLab: yours is written down; a check that could not answer is refused too', async () => {
    const d = deps();
    await setScope(d, 'gitlab', { scope: 'yours' }, { via: 'cli' });
    expect(d.store.scopes['gitlab']).toEqual({ kind: 'yours' });
    const err = await setScope(deps({ table: [[/projects/, { status: 500 }]] }), 'gitlab', { scope: 'team', values: 'g/p' }, { via: 'cli' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(err.kind).toBe('unverified');
  });

  it('GitLab: a visible project is stored; a hidden one is refused', async () => {
    const d = deps({ table: [[/api\/v4\/projects\/g%2Fp/, { status: 200 }]] });
    await setScope(d, 'gitlab', { scope: 'team', values: 'g/p' }, { via: 'cli' });
    expect(d.store.scopes['gitlab']).toEqual({ kind: 'team', values: ['g/p'], labels: ['g/p'] });
    const err = await setScope(deps({ table: [[/projects/, { status: 404 }]] }), 'gitlab', { scope: 'team', values: 'g/p' }, { via: 'cli' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(err.kind).toBe('not_visible');
  });

  it('works with no graph file yet: the choice is stored and the first sync creates the row (the file is not created)', async () => {
    const d = deps({ dbPath: path.join(dir, 'none.db'), table: [jiraProjects('ALI')] });
    const r = await setScope(d, 'jira', { scope: 'team', values: ['ALI'] }, { via: 'cli' });
    expect(d.store.scopes['jira']).toBeDefined();
    expect(fs.existsSync(path.join(dir, 'none.db'))).toBe(false);
    expect(r.newRow).toBe(true);
  });
});

describe('setScope with a truncated list (past the cap a real key is not "cannot see")', () => {
  const cut: Route = [/rest\/api\/3\/project\/search/, { body: { values: [{ key: 'ALI', name: 'a' }], isLast: false, startAt: 0, maxResults: 1 } }];

  it('Jira: a key missing from the cut list is asked for directly and accepted when it exists', async () => {
    const d = deps({ listMax: 1, table: [cut, [/rest\/api\/3\/project\/OPS$/, { body: { key: 'OPS' } }]] });
    await setScope(d, 'jira', { scope: 'team', values: ['ALI', 'OPS'] }, { via: 'cli' });
    expect(d.store.scopes['jira']).toMatchObject({ kind: 'team', values: ['ALI', 'OPS'] });
    expect(d.calls.some((u) => u.endsWith('/project/OPS'))).toBe(true);
    expect(d.calls.some((u) => u.endsWith('/project/ALI'))).toBe(false);
  });

  it('Jira: a key that the direct lookup also cannot find is refused, and the message says the list was cut off', async () => {
    const d = deps({ listMax: 1, table: [cut, [/project\/NOPE$/, { status: 404 }]] });
    const err = await setScope(d, 'jira', { scope: 'team', values: ['NOPE'] }, { via: 'cli' }).catch((e: unknown) => e) as ScopeRefusal;
    expect(err.kind).toBe('not_visible');
    expect(err.message).toContain('NOPE');
    expect(err.message).toContain('list was cut off after 1');
    expect(d.store.scopes['jira']).toBeUndefined();
  });

  it('an untruncated list never makes a direct request (a missing key is just missing)', async () => {
    const d = deps({ table: [jiraProjects('ALI')] });
    await setScope(d, 'jira', { scope: 'team', values: ['NOPE'] }, { via: 'cli' }).catch(() => undefined);
    expect(d.calls.every((u) => u.includes('/project/search'))).toBe(true);
  });

  it('Linear: a team key past the first page is found by its key and stored as its id', async () => {
    const bodies = [
      { data: { teams: { nodes: [{ id: 'id-A', key: 'AAA', name: 'a' }], pageInfo: { hasNextPage: true } } } },
      { data: { teams: { nodes: [{ id: 'id-Z', key: 'ZZZ', name: 'z' }] } } },
    ];
    let n = 0;
    const d = deps({ fetch: (async () => new Response(JSON.stringify(bodies[Math.min(n++, 1)]), { status: 200 })) as unknown as typeof fetch });
    await setScope(d, 'linear', { scope: 'team', values: ['ZZZ'] }, { via: 'cli' });
    expect(d.store.scopes['linear']).toEqual({ kind: 'team', values: ['id-Z'], labels: ['ZZZ'] });
  });
});

describe('viewScopes', () => {
  it('lists connected sources only, with kind, key and words, and nothing secret', async () => {
    const store = memStore({ connected: ['github', 'jira', 'zoom', 'slack'], scopes: { jira: { kind: 'team', values: ['ALI', 'OPS'], labels: ['ALI', 'OPS'] } } });
    const v = await viewScopes(deps({ store, cwdRepo: async () => 'o/r' }));
    expect(v.map((x) => x.source)).toEqual(['github', 'jira', 'slack', 'zoom']);
    expect(v.find((x) => x.source === 'jira')).toMatchObject({ kind: 'team', scope_key: 'jira:ALI,OPS', values: ['ALI', 'OPS'], can_set: true });
    expect(v.find((x) => x.source === 'github')).toMatchObject({ kind: 'team', scope_key: 'repo:o/r', origin: 'detected', can_set: true });
    expect(v.find((x) => x.source === 'zoom')).toMatchObject({ kind: 'yours', can_set: false });
    expect(v.find((x) => x.source === 'slack')).toMatchObject({ kind: 'team', can_set: false });
    expect(JSON.stringify(v)).not.toContain(TOKEN);
  });

  it('makes no network call; Confluence with no spaces is "unset"; Jira with none is yours', async () => {
    const d = deps({ store: memStore({ connected: ['jira', 'confluence'] }) });
    const v = await viewScopes(d);
    expect(d.calls).toHaveLength(0);
    expect(v.find((x) => x.source === 'confluence')).toMatchObject({ kind: 'unset' });
    expect(v.find((x) => x.source === 'jira')).toMatchObject({ kind: 'yours', scope_key: 'yours' });
  });

  it('no connected source gives an empty list', async () => {
    expect(await viewScopes(deps({ store: memStore({ connected: [] }) }))).toEqual([]);
  });
});
