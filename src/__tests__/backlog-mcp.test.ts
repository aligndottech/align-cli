import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchTool, TOOL_SCHEMAS } from '../commands/mcp.js';
import { BACKLOG_TOOL, BACKLOG_TOOL_SCHEMA, type BacklogToolContext, runBacklogTool } from '../lib/mcp/backlog-tool.js';
import { PLAN_TTL_MS, takePlan } from '../lib/backlog/pending.js';
import { creates, DEC, type Fx, fixture as makeFixture } from './helpers/backlog-fixture.js';

/**
 * Test List, the `align_backlog` MCP tool (an agent asks, the person says yes, the tool creates):
 * - the plan call returns tracker, destination, the task titles and a plan token, and creates NOTHING: no write request, no ledger row.
 * - a confirm with no token, an invented token, a token shaped like a path, or an expired token creates nothing.
 * - a confirm with the token creates exactly the tasks the plan showed, without asking the model again, once: the token is spent.
 * - an ambiguous tracker, team or decision comes back as a structured question with options; nothing is shaped or sent.
 * - a saved target is used with no question and the plan says so; a flag overrides it.
 * - a decision that already has issues here returns them and no token; a confirm after another run created them creates nothing.
 * - the schema is closed (no token or key can be passed), says when to call it and to show the plan first, and is a write.
 * - a server frozen with --created-before refuses it.
 */
let dir: string;
let planDir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-backlog-mcp-')); planDir = path.join(dir, 'plans'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const fx = (): Fx => makeFixture(dir);
const ctx = (f: Fx): BacklogToolContext => ({ backlog: { makeDeps: (io) => ({ ...f.deps, out: io.out, err: io.err }), planDir } });
const rb = (args: Record<string, unknown>, f: Fx) => runBacklogTool(args, {} as never, {} as never, ctx(f));
const call = (f: Fx, args: Record<string, unknown>) => rb({ decision: DEC.id, tracker: 'linear', team: 'ENG', ...args }, f);
type R = Record<string, unknown> & { text: string };
const plan = async (f: Fx, args: Record<string, unknown> = {}): Promise<R> => (await call(f, args)) as R;
const confirm = (f: Fx, token: unknown) => rb({ plan_id: token }, f);

describe('the plan call creates nothing', () => {
  it('returns tracker, destination, the titles and a token, and sends no write and writes no ledger', async () => {
    const f = fx();
    const r = await plan(f);
    expect(r).toMatchObject({ status: 'plan', tracker: 'linear', destination: 'ENG', count: 2, used_saved_target: false });
    expect(r['tasks']).toEqual([{ title: 'Add OIDC provider config', body: 'Wire the provider.' }, { title: 'Migrate login route', body: 'Switch the route.' }]);
    expect(r.text).toContain('Wire the provider.'); // the body goes to the tracker, so the person sees it too
    expect(r['plan_id']).toMatch(/^[0-9a-f]{24}$/);
    expect(r.text).toMatch(/nothing has been created/i); expect(r.text).toContain('Migrate login route');
    expect(creates(f)).toHaveLength(0);
    expect(fs.existsSync(f.deps.ledgerPath)).toBe(false);
    expect(f.saved.writes).toHaveLength(0);
    // Positive control: the call did real work (it shaped tasks and wrote the pending plan), so "nothing created" is not "nothing ran".
    expect(f.shapeCalls.n).toBe(1); expect(fs.readdirSync(planDir)).toHaveLength(1);
  });
  it('never puts the credential in the plan or its file', async () => {
    const f = fx(); const r = await plan(f);
    expect(JSON.stringify(r)).not.toContain('lin_api_x');
    expect(fs.readFileSync(path.join(planDir, fs.readdirSync(planDir)[0]!), 'utf8')).not.toContain('lin_api_x');
  });
});

describe('a confirm that does not hold a valid plan creates nothing', () => {
  it.each([
    ['no token at all', undefined],
    ['an empty token', ''],
    ['a token nobody issued', 'a'.repeat(24)],
    ['a token shaped like a path', '../../etc/passwd'],
    ['a token that is not text', 42],
  ])('%s', async (_n, token) => {
    const f = fx(); await plan(f); f.calls.length = 0;
    await expect(confirm(f, token)).rejects.toThrow();
    expect(creates(f)).toHaveLength(0);
    expect(fs.existsSync(f.deps.ledgerPath)).toBe(false);
  });
  it('an expired token', async () => {
    const f = fx(); const r = await plan(f);
    const file = path.join(planDir, `${r['plan_id'] as string}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { expiresAt: string };
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(stored));
    await expect(confirm(f, r['plan_id'])).rejects.toThrow(/no pending plan/i);
    expect(creates(f)).toHaveLength(0);
    expect(PLAN_TTL_MS).toBeGreaterThan(0);
  });
  it('a plan call alone, however often it is repeated, never creates', async () => {
    const f = fx(); await plan(f); await plan(f); await plan(f);
    expect(creates(f)).toHaveLength(0);
  });
});

describe('a token names a plan file and nothing else', () => {
  it('a path-shaped token is refused before any path is built, even where a readable plan sits', () => {
    // Positive control: the planted file IS a valid, unexpired plan, so a null answer can only come from the shape check.
    fs.mkdirSync(planDir, { recursive: true });
    const planted = path.join(dir, 'evil.json');
    fs.writeFileSync(planted, JSON.stringify({ decision: DEC, tracker: 'linear', target: 'ENG', key: 'k', tasks: [], expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    expect(takePlan(planDir, '../evil')).toBeNull();
    expect(fs.existsSync(planted)).toBe(true);
  });
});

describe('a confirm with the token creates exactly the plan', () => {
  it('creates the titles it showed, does not ask the model again, and spends the token', async () => {
    const f = fx();
    const p = await plan(f);
    f.model.current = { ok: true, text: JSON.stringify({ tasks: [{ title: 'A completely different task', body: 'x' }] }) };
    const r = await confirm(f, p['plan_id']) as R;
    expect(r['status']).toBe('created');
    expect(f.shapeCalls.n).toBe(1);
    const titles = creates(f).map((c) => (JSON.parse(c.body) as { variables: { input: { title: string } } }).variables.input.title);
    expect(titles).toEqual(['Add OIDC provider config', 'Migrate login route']);
    expect(r['created']).toEqual([
      { key: 'ENG-1', url: 'https://linear.app/t/issue/ENG-1', title: 'Add OIDC provider config' },
      { key: 'ENG-2', url: 'https://linear.app/t/issue/ENG-2', title: 'Migrate login route' },
    ]);
    f.calls.length = 0;
    await expect(confirm(f, p['plan_id'])).rejects.toThrow(/no pending plan/i);
    expect(creates(f)).toHaveLength(0);
  });
  it('saves the destination for this repo when it worked', async () => {
    const f = fx(); const p = await plan(f);
    await confirm(f, p['plan_id']);
    expect(f.saved.writes).toEqual([{ tracker: 'linear', target: 'ENG' }]);
  });
  it('a confirm after another run already created them creates nothing', async () => {
    const f = fx(); const p = await plan(f);
    const { runBacklog } = await import('../lib/backlog/run.js');
    await runBacklog({ decision: DEC.id, tracker: 'linear', team: 'ENG' }, f.deps);
    f.calls.length = 0;
    const r = await confirm(f, p['plan_id']) as R;
    expect(creates(f)).toHaveLength(0);
    expect(r['status']).toBe('already_created');
  });
  it('a plan for a decision that already has issues here returns them and no token', async () => {
    const f = fx(); const p = await plan(f); await confirm(f, p['plan_id']);
    const again = await plan(f);
    expect(again['status']).toBe('already_created'); expect(again['plan_id']).toBeUndefined();
    expect(again['issues']).toHaveLength(2);
  });
});

describe('a confirm that cannot go ahead says why and does not burn the plan', () => {
  it('a missing credential keeps the token usable', async () => {
    const f = fx(); const p = await plan(f);
    f.creds['linear'] = null;
    await expect(confirm(f, p['plan_id'])).rejects.toThrow(/credential/i);
    f.creds['linear'] = { token: 'lin_api_x' };
    expect((await confirm(f, p['plan_id']) as R)['status']).toBe('created');
  });
  it('a busy ledger keeps the token usable', async () => {
    const f = fx(); const p = await plan(f);
    fs.writeFileSync(`${f.deps.ledgerPath}.lock`, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce: 'other' }));
    await expect(confirm(f, p['plan_id'])).rejects.toThrow(/already running/i);
    fs.rmSync(`${f.deps.ledgerPath}.lock`);
    expect((await confirm(f, p['plan_id']) as R)['status']).toBe('created');
  });
  it('a task list that changed since the plan is not created', async () => {
    const f = fx(); const p = await plan(f);
    fs.writeFileSync(f.deps.ledgerPath, JSON.stringify({ [`${DEC.id}|linear|acme|eng`]: { at: 'x', tasks: [{ title: 'A different task', body: 'b' }] } }));
    const r = await confirm(f, p['plan_id']) as R;
    expect(r['status']).toBe('plan_changed'); expect(creates(f)).toHaveLength(0);
  });
  it('an issue an earlier run may already have made is not created again on a blind confirm', async () => {
    const f = fx(); const p = await plan(f);
    fs.writeFileSync(f.deps.ledgerPath, JSON.stringify({ [`${DEC.id}|linear|acme|eng`]: { at: 'x', tasks: [{ title: 'Add OIDC provider config', body: 'Wire the provider.', uncertain: true }, { title: 'Migrate login route', body: 'Switch the route.' }] } }));
    const r = await confirm(f, p['plan_id']) as R;
    expect(r['status']).toBe('needs_check'); expect(creates(f)).toHaveLength(0);
  });
});

describe('an ambiguity is a question, not a failure', () => {
  it('two trackers: the options, and nothing shaped or sent', async () => {
    const f = fx(); f.creds['github'] = { token: 'g' };
    const r = await plan(f, { tracker: undefined, team: undefined });
    expect(r).toMatchObject({ status: 'needs_choice', field: 'tracker' });
    expect(r['options']).toEqual([{ value: 'linear', label: 'Linear' }, { value: 'github', label: 'GitHub Issues' }]);
    expect(r.text).toMatch(/ask the user/i);
    expect(f.shapeCalls.n).toBe(0); expect(creates(f)).toHaveLength(0);
  });
  it('two teams: the team keys and names', async () => {
    const f = fx();
    const r = await plan(f, { team: undefined });
    expect(r).toMatchObject({ status: 'needs_choice', field: 'team' });
    expect(r['options']).toEqual([{ value: 'ENG', label: 'ENG  Align' }, { value: 'OPS', label: 'OPS  Ops' }]);
  });
  it('answering it (the flag the question named) gets the plan', async () => {
    const f = fx();
    expect(await plan(f, { team: 'OPS' })).toMatchObject({ status: 'plan', destination: 'OPS' });
  });
});

describe('a saved target', () => {
  it('is used with no question, and the plan says so', async () => {
    const f = fx(); f.creds['github'] = { token: 'g' }; f.saved.current = { tracker: 'linear', target: 'ENG' };
    const r = await plan(f, { tracker: undefined, team: undefined });
    expect(r).toMatchObject({ status: 'plan', tracker: 'linear', destination: 'ENG', used_saved_target: true });
    expect(r.text).toMatch(/saved target/i);
  });
  it('is overridden by a flag', async () => {
    const f = fx(); f.saved.current = { tracker: 'linear', target: 'ENG' };
    expect(await plan(f, { team: 'OPS' })).toMatchObject({ destination: 'OPS', used_saved_target: false });
  });
});

describe('the tool as an agent sees it', () => {
  it('is registered, and is a write that does not destroy', () => {
    const t = TOOL_SCHEMAS.find((x) => x.name === BACKLOG_TOOL) as { annotations: { readOnlyHint: boolean; destructiveHint: boolean } } | undefined;
    expect(t).toBeDefined();
    expect(t!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
  });
  it('says when to call it and to show the plan first', () => {
    const d = BACKLOG_TOOL_SCHEMA.description;
    expect(d).toMatch(/only when the user asks/i);
    expect(d).toMatch(/show the plan to the user/i);
    expect(d).toMatch(/nothing is created until/i);
  });
  it('has a closed schema with no place for a token or key', () => {
    const s = BACKLOG_TOOL_SCHEMA.inputSchema as { properties: Record<string, unknown>; additionalProperties: boolean };
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties).sort()).toEqual(['decision', 'plan_id', 'project', 'repo', 'team', 'tracker']);
  });
  it('refuses an unknown property by name without echoing its value', async () => {
    const f = fx();
    await expect(rb({ decision: DEC.id, token: 'lin_api_SECRET' }, f)).rejects.toThrow(/does not accept an unknown property/);
    await expect(rb({ decision: DEC.id, token: 'lin_api_SECRET' }, f)).rejects.not.toThrow(/SECRET/);
  });
  it('wants a decision to plan, or a token to confirm, and not both', async () => {
    const f = fx();
    await expect(rb({}, f)).rejects.toThrow(/decision/);
    await expect(rb({ decision: DEC.id, plan_id: 'a'.repeat(24) }, f)).rejects.toThrow(/not both|only/i);
  });
  it('is routed by dispatchTool, and a server frozen with --created-before refuses it', async () => {
    const f = fx();
    const env = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't' } as never;
    const r = await dispatchTool(BACKLOG_TOOL, { decision: DEC.id, tracker: 'linear', team: 'ENG' }, {} as never, env, undefined, ctx(f) as never) as R;
    expect(r['status']).toBe('plan');
    await expect(dispatchTool(BACKLOG_TOOL, { decision: DEC.id }, {} as never, env, '2026-01-01T00:00:00.000Z', ctx(f) as never)).rejects.toThrow(/frozen/);
  });
});
