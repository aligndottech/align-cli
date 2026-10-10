import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { runScopeTool, SCOPE_TOOL, SCOPE_TOOL_SCHEMA } from '../lib/mcp-scope.js';
import { beginRun, readRows } from '../lib/sync/sync-state.js';
import { jiraProjects, makeDeps, memStore, type Route, TOKEN } from './helpers/scope-deps.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * L4 Test List (align_scope):
 * - The schema is closed and small; no property name looks like a secret (positive control: the same check flags one that does).
 * - A token or key, or any unknown property, is refused before anything runs: the tool error names the property (cut) and never its value.
 * - view: connected sources, each with kind, key and words; none connected gives an empty list and the connect command.
 * - set: a team scope for a connected source writes through setScope (the CLI's path), records `via mcp` and the agent, and returns the
 *   disclosure and the cost of widening. yours narrows back. Exactly the one value property its source takes.
 * - Zoom says it is only yours. An unconnected source returns `align connect <source>` and changes nothing.
 * - A hosted server refuses: this edits what the local graph reads.
 */
const localEnv = { mode: 'local-embedded', gatewayUrl: '', authToken: null, tenantId: null, localDbPath: '/ignored/graph.db' } as EnvironmentConfig;
const cloudEnv = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't', tenantId: null } as EnvironmentConfig;

let dir: string;
let dbPath: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l4-mcp-scope-')); dbPath = path.join(dir, 'graph.db'); createLocalGatewayClient(dbPath).close(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const d = (over: Parameters<typeof makeDeps>[1] = {}): ReturnType<typeof makeDeps> => makeDeps(dbPath, over);

describe('schema', () => {
  it('is closed, requires action, and offers only view and set', () => {
    expect(SCOPE_TOOL).toBe('align_scope');
    expect(SCOPE_TOOL_SCHEMA.inputSchema.additionalProperties).toBe(false);
    expect(SCOPE_TOOL_SCHEMA.inputSchema.required).toEqual(['action']);
    expect(SCOPE_TOOL_SCHEMA.inputSchema.properties.action.enum).toEqual(['view', 'set']);
    expect(Object.keys(SCOPE_TOOL_SCHEMA.inputSchema.properties).sort()).toEqual(['action', 'gitlab_project', 'projects', 'repo', 'scope', 'source', 'spaces', 'teams']);
  });

  it('no property is named like a secret (and the same check flags one that is)', () => {
    const secretLike = /token|key|secret|password|credential/i;
    expect(Object.keys(SCOPE_TOOL_SCHEMA.inputSchema.properties).filter((k) => secretLike.test(k))).toEqual([]);
    expect(Object.keys({ action: 1, apiKey: 2 }).filter((k) => secretLike.test(k))).toEqual(['apiKey']);
  });

  it('its description tells the agent when to offer it, what widening costs, and that it never takes a token', () => {
    const t = SCOPE_TOOL_SCHEMA.description;
    expect(t).toContain('ALREADY connected');
    expect(t).toContain('re-reads');
    expect(t).toContain('deletes nothing');
    expect(t).toContain('align connect <source>');
    expect(t).toContain('Zoom');
    // Honest about the gate: a prompt a shell-capable agent could in principle answer is a speed bump, not proof.
    expect(t).toContain('speed bump, not proof');
    expect(t).toContain('pseudo-terminal');
    expect(t.length).toBeLessThan(1700);
  });

  it('refuses a token or key before anything runs, naming the property and never the value (two examples)', async () => {
    const deps = d({ table: [jiraProjects('ALI')] });
    await expect(runScopeTool({ action: 'set', source: 'jira', projects: ['ALI'], token: 'ghp_SECRETVALUE0123456789' }, localEnv, deps)).rejects.toThrow(/"token"/);
    await expect(runScopeTool({ action: 'view', api_key: 'sk-ant-SECRETVALUE' }, localEnv, deps)).rejects.toThrow(/"api_key"/);
    try { await runScopeTool({ action: 'view', token: 'ghp_SECRETVALUE0123456789' }, localEnv, deps); } catch (e) { expect((e as Error).message).not.toContain('SECRETVALUE'); }
    expect(deps.calls).toHaveLength(0);
    expect(deps.store.scopes).toEqual({});
  });

  it('a bad action, source or value shape is a tool error that names what is accepted', async () => {
    await expect(runScopeTool({}, localEnv, d())).rejects.toThrow(/requires "action"/);
    await expect(runScopeTool({ action: 'delete' }, localEnv, d())).rejects.toThrow(/requires "action"/);
    await expect(runScopeTool({ action: 'set' }, localEnv, d())).rejects.toThrow(/requires "source"/);
    await expect(runScopeTool({ action: 'set', source: 'myspace' }, localEnv, d())).rejects.toThrow(/"source" must be one of/);
    await expect(runScopeTool({ action: 'set', source: 'jira', projects: 'ALI' }, localEnv, d())).rejects.toThrow(/"projects" must be a list of text values/);
    await expect(runScopeTool({ action: 'set', source: 'jira', scope: 'everyone' }, localEnv, d())).rejects.toThrow(/"scope" must be "yours" or "team"/);
  });

  it('a hosted server refuses: this edits what the local graph reads', async () => {
    await expect(runScopeTool({ action: 'view' }, cloudEnv, d())).rejects.toThrow(/local graph/);
  });
});

describe('what the consent gate does not claim', () => {
  it('the docs and the tool say plainly that a shell-capable agent with a pseudo-terminal can still confirm (a pty is not detectable, so it is documented, not tested)', () => {
    const docs = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'importing.md'), 'utf8');
    expect(docs).toContain('pseudo-terminal');
    expect(docs).toContain('speed bump, not as proof');
    expect(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'mcp.md'), 'utf8')).toContain('speed bump, not proof');
    expect(SCOPE_TOOL_SCHEMA.description).toContain('speed bump, not proof');
  });
});

describe('view', () => {
  it('lists connected sources with kind, key and words, and no secret', async () => {
    const store = memStore({ connected: ['github', 'jira', 'zoom'], scopes: { jira: { kind: 'team', values: ['ALI', 'OPS'], labels: ['ALI', 'OPS'] } } });
    const r = await runScopeTool({ action: 'view' }, localEnv, d({ store }));
    const sources = r['sources'] as Array<{ source: string; kind: string; scope_key: string }>;
    expect(sources.map((s) => `${s.source}:${s.kind}:${s.scope_key}`)).toEqual(['github:yours:yours', 'jira:team:jira:ALI,OPS', 'zoom:yours:yours']);
    expect(r.text).toContain("Jira: everyone's items in Jira projects ALI, OPS");
    expect(r.text).toContain('Zoom: only your own');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('no connected source: an empty list and the connect command for the person', async () => {
    const r = await runScopeTool({ action: 'view' }, localEnv, d({ store: memStore({ connected: [] }) }));
    expect(r['sources']).toEqual([]);
    expect(r.text).toContain('align connect <source>');
  });
});

describe('set', () => {
  it('writes a team scope through the CLI path: a new row, via mcp with the agent, the disclosure and the cost in the reply', async () => {
    beginRun(dbPath, { source: 'jira', scopeKey: 'yours', scope: 'yours' }, '2026-04-12T12:00:00.000Z', '2026-10-10T12:00:00.000Z');
    const deps = d({ table: [jiraProjects('ALI', 'OPS')] });
    const r = await runScopeTool({ action: 'set', source: 'jira', projects: ['OPS'] }, localEnv, deps, { agent: 'claude-code' });
    // An agent's team choice WAITS for a person: stored as pending, with what stays in force meanwhile.
    expect(deps.store.scopes['jira']).toEqual({ kind: 'team', values: ['OPS'], labels: ['OPS'], pending: { previous: null } });
    expect(readRows(dbPath, 'jira').find((x) => x.scope_key === 'jira:OPS')).toMatchObject({ scope: 'team', changed_via: 'mcp', changed_by_agent: 'claude-code', high_water: null });
    expect(r.text).toContain('Importing items from everyone in Jira project OPS that your token can read. They stay on this machine.');
    expect(r.text).toContain('re-reads Jira back to 2026-04-12');
    expect(r.text).toContain('Nothing already imported is deleted');
    expect(r.text).toContain('waiting for the person');
    expect(r.text).toContain('align sync jira');
    expect(r).toMatchObject({ source: 'jira', scope: 'team', scope_key: 'jira:OPS', new_scope: true, pending: true });
  });

  it('attributes to "unknown" when the client did not identify itself', async () => {
    await runScopeTool({ action: 'set', source: 'jira', projects: ['ALI'] }, localEnv, d({ table: [jiraProjects('ALI')] }));
    expect(readRows(dbPath, 'jira').find((x) => x.scope_key === 'jira:ALI')!.changed_by_agent).toBe('unknown');
  });

  it('scope "yours" narrows back and says what stays', async () => {
    const store = memStore({ scopes: { jira: { kind: 'team', values: ['OPS'], labels: ['OPS'] } } });
    const r = await runScopeTool({ action: 'set', source: 'jira', scope: 'yours' }, localEnv, d({ store }));
    expect(store.scopes['jira']).toEqual({ kind: 'yours' });
    expect(r.text).toContain('stay in your graph');
    expect(r).toMatchObject({ scope: 'yours', scope_key: 'yours' });
  });

  it('each source takes its own value property and no other (github, linear, gitlab, confluence)', async () => {
    const teams: Route = [/api\.linear\.app/, { body: { data: { teams: { nodes: [{ id: 'id-1', key: 'ENG', name: 'E' }] } } } }];
    const spaces: Route = [/wiki\/api\/v2\/spaces/, { body: { results: [{ key: 'OPS', name: 'O' }] } }];
    const deps = d({ table: [[/api\.github\.com\/search/, { status: 200 }], [/api\/v4\/projects/, { status: 200 }], teams, spaces] });
    await runScopeTool({ action: 'set', source: 'github', repo: 'o/r' }, localEnv, deps);
    await runScopeTool({ action: 'set', source: 'linear', teams: ['ENG'] }, localEnv, deps);
    await runScopeTool({ action: 'set', source: 'gitlab', gitlab_project: 'g/p' }, localEnv, deps);
    await runScopeTool({ action: 'set', source: 'confluence', spaces: ['OPS'] }, localEnv, deps);
    expect(Object.keys(deps.store.scopes).sort()).toEqual(['confluence', 'github', 'gitlab', 'linear']);
    await expect(runScopeTool({ action: 'set', source: 'jira', spaces: ['OPS'] }, localEnv, d())).rejects.toThrow(/jira takes "projects"/);
    await expect(runScopeTool({ action: 'set', source: 'github', repo: 'o/r', projects: ['ALI'] }, localEnv, d())).rejects.toThrow(/github takes "repo"/);
  });

  it('"team" with no value says which property to pass; "yours" with a value is refused as contradictory', async () => {
    await expect(runScopeTool({ action: 'set', source: 'jira', scope: 'team' }, localEnv, d())).rejects.toThrow(/"projects"/);
    await expect(runScopeTool({ action: 'set', source: 'jira' }, localEnv, d())).rejects.toThrow(/"projects"/);
    await expect(runScopeTool({ action: 'set', source: 'jira', scope: 'yours', projects: ['ALI'] }, localEnv, d())).rejects.toThrow(/either/);
  });

  it('Zoom is a tool error saying it is only yours; nothing is stored', async () => {
    const deps = d();
    await expect(runScopeTool({ action: 'set', source: 'zoom', scope: 'team' }, localEnv, deps)).rejects.toThrow(/only your own/);
    expect(deps.store.scopes).toEqual({});
  });

  it('an unconnected source returns the connect command and changes nothing', async () => {
    const deps = d({ store: memStore({ connected: ['github'] }) });
    await expect(runScopeTool({ action: 'set', source: 'jira', projects: ['ALI'] }, localEnv, deps)).rejects.toThrow(/align connect jira/);
    expect(deps.calls).toHaveLength(0);
    expect(deps.store.scopes).toEqual({});
  });

  it('a project the token cannot see is refused by key, with nothing stored', async () => {
    const deps = d({ table: [jiraProjects('ALI')] });
    await expect(runScopeTool({ action: 'set', source: 'jira', projects: ['NOPE'] }, localEnv, deps)).rejects.toThrow(/cannot see 1 of the projects you gave/);
    expect(deps.store.scopes).toEqual({});
  });

  it('an invalid value is refused without being echoed', async () => {
    const deps = d({ table: [jiraProjects('ALI')] });
    let message = '';
    try { await runScopeTool({ action: 'set', source: 'jira', projects: ['ghp_SECRETVALUE0123456789'] }, localEnv, deps); } catch (e) { message = (e as Error).message; }
    expect(message).not.toBe('');
    expect(message).not.toContain('SECRETVALUE');
  });
});
