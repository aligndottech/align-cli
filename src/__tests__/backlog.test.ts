import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BacklogDeps, type BacklogOptions, type DecisionInput, runBacklog } from '../lib/backlog/run.js';

/**
 * Test List, `align backlog` (a person-run command: one decision -> one issue per task, created straight away):
 * - dry-run: prints tracker, target and N issues; sends NO request at all; writes no ledger row.
 * - linear: one issueCreate per task, team resolved from --team, description links back to the decision and its source.
 * - github and jira: one create per task against the repo / project given.
 * - idempotent: a second run on the same decision + target creates nothing; --force creates again.
 * - resume: a create that fails mid-run is recorded as it happened; the rerun creates only the missing ones from the SAME plan.
 * - missing credentials: exit 1, names the connect command, no shaping call, no request.
 * - missing model: exit 1, no tasks invented, no request. Unreadable model output: same.
 * - ambiguous target (2 teams) or tracker (2 credentials): non-TTY exits 2 naming the flag; TTY asks once.
 * - a credential that cannot create issues (403): exit 1 saying so, nothing recorded.
 * - model text has no em dashes; more tasks than --max are cut and said so.
 */
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-backlog-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const DEC: DecisionInput = { id: '3f2a9c1e-0000-4000-8000-000000000001', title: 'Move auth to OIDC', summary: 'We use OIDC for all logins.', sourceUrl: 'https://github.com/o/r/pull/9', actions: ['Add OIDC provider config'] };
const TASKS = JSON.stringify({ tasks: [{ title: 'Add OIDC provider config', body: 'Wire the provider.' }, { title: 'Migrate login route', body: 'Switch the route.' }] });

interface Fx { out: string[]; err: string[]; calls: Array<{ url: string; body: string }>; shapeCalls: { n: number }; deps: BacklogDeps; asks: string[]; model: { current: { ok: true; text: string } | { ok: false; message: string } }; creds: Record<string, Record<string, string> | null>; failNext: { n: number; status: number } }
function fixture(): Fx {
  const f = { out: [] as string[], err: [] as string[], calls: [] as Array<{ url: string; body: string }>, shapeCalls: { n: 0 }, asks: [] as string[],
    model: { current: { ok: true, text: TASKS } as Fx['model']['current'] },
    creds: { linear: { token: 'lin_api_x' }, github: null, jira: null } as Fx['creds'], failNext: { n: 0, status: 500 } };
  let n = 0;
  const fetchFake = (async (url: string, init?: { body?: string }) => {
    const body = init?.body ?? '';
    f.calls.push({ url, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.includes('api.linear.app')) {
      if (body.includes('issueCreate')) {
        if (f.failNext.n > 0) { f.failNext.n--; return json({}, f.failNext.status); }
        n++; return json({ data: { issueCreate: { success: true, issue: { identifier: `ENG-${n}`, url: `https://linear.app/t/issue/ENG-${n}` } } } });
      }
      if (body.includes('first: 100')) return json({ data: { teams: { nodes: [{ id: 'T1', key: 'ENG', name: 'Align' }, { id: 'T2', key: 'OPS', name: 'Ops' }], pageInfo: { hasNextPage: false } } } });
      return json({ data: { teams: { nodes: [{ id: 'T1', key: 'ENG', name: 'Align' }] } } });
    }
    if (url.includes('api.github.com')) { n++; return json({ number: n, html_url: `https://github.com/o/r/issues/${n}` }, 201); }
    if (url.includes('/rest/api/3/issue')) { n++; return json({ key: `PRJ-${n}` }, 201); }
    return json({}, 404);
  }) as unknown as typeof fetch;
  const deps: BacklogDeps = {
    getDecision: async (id) => { if (id !== DEC.id) throw new Error('not found'); return DEC; },
    search: async () => [DEC],
    shape: async () => { f.shapeCalls.n++; return f.model.current; },
    credentials: (t) => f.creds[t] ?? null,
    fetch: fetchFake, ledgerPath: path.join(dir, 'ledger.json'), interactive: false,
    choose: async (q, opts) => { f.asks.push(q); return opts[0]!.value; },
    decisionUrl: (id) => `https://app.align.tech/decisions/${id}`,
    out: (l) => f.out.push(l), err: (l) => f.err.push(l),
  };
  return Object.assign(f, { deps }) as unknown as Fx;
}
const run = (f: Fx, o: Partial<BacklogOptions> = {}) => runBacklog({ decision: '3f2a9c1e-0000-4000-8000-000000000001', tracker: 'linear', team: 'ENG', ...o }, f.deps);
const text = (f: Fx) => [...f.out, ...f.err].join('\n');
const creates = (f: Fx) => f.calls.filter((c) => c.body.includes('issueCreate') || c.url.includes('/issues') || c.url.includes('/rest/api/3/issue'));

describe('dry-run', () => {
  it('prints tracker, target and count, and sends no request and writes no ledger', async () => {
    const f = fixture();
    expect(await run(f, { dryRun: true })).toBe(0);
    expect(f.calls).toHaveLength(0);
    expect(fs.existsSync(f.deps.ledgerPath)).toBe(false);
    expect(text(f)).toMatch(/Linear/); expect(text(f)).toContain('ENG'); expect(text(f)).toContain('2 issues');
    expect(text(f)).toContain('Add OIDC provider config');
  });
});

describe('linear', () => {
  it('creates one issue per task with a link back to the decision and its source', async () => {
    const f = fixture();
    expect(await run(f)).toBe(0);
    const made = creates(f);
    expect(made).toHaveLength(2);
    const first = JSON.parse(made[0]!.body) as { variables: { input: { teamId: string; title: string; description: string } } };
    expect(first.variables.input.teamId).toBe('T1');
    expect(first.variables.input.title).toBe('Add OIDC provider config');
    expect(first.variables.input.description).toContain('https://app.align.tech/decisions/3f2a9c1e-0000-4000-8000-000000000001');
    expect(first.variables.input.description).toContain('https://github.com/o/r/pull/9');
    expect(text(f)).toContain('ENG-1'); expect(text(f)).toContain('ENG-2');
  });
});

describe('github and jira', () => {
  it('github: one POST per task to the repo given', async () => {
    const f = fixture(); f.creds['github'] = { token: 'ghp_x' };
    expect(await run(f, { tracker: 'github', team: undefined, repo: 'o/r' })).toBe(0);
    const made = creates(f);
    expect(made.map((c) => c.url)).toEqual(['https://api.github.com/repos/o/r/issues', 'https://api.github.com/repos/o/r/issues']);
    expect((JSON.parse(made[0]!.body) as { title: string; body: string }).body).toContain('https://github.com/o/r/pull/9');
    expect((JSON.parse(made[0]!.body) as { title: string }).title).toBe('Add OIDC provider config');
    expect(text(f)).toContain('https://github.com/o/r/issues/1');
  });
  it('jira: one POST per task to the project given, on the saved site', async () => {
    const f = fixture(); f.creds['jira'] = { token: 't', email: 'a@b.co', domain: 'acme.atlassian.net' };
    expect(await run(f, { tracker: 'jira', team: undefined, project: 'PRJ' })).toBe(0);
    const made = creates(f);
    expect(made).toHaveLength(2);
    expect(made[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue');
    const jf = (JSON.parse(made[0]!.body) as { fields: { project: { key: string }; summary: string; issuetype: { name: string }; description: { type: string } } }).fields;
    expect(jf.project.key).toBe('PRJ'); expect(jf.summary).toBe('Add OIDC provider config'); expect(jf.issuetype.name).toBe('Task'); expect(jf.description.type).toBe('doc');
    expect(text(f)).toContain('https://acme.atlassian.net/browse/PRJ-1');
  });
});

describe('idempotency and resume', () => {
  it('a second run creates nothing and shapes nothing; --force creates again', async () => {
    const f = fixture();
    await run(f);
    f.calls.length = 0; f.out.length = 0;
    expect(await run(f)).toBe(0);
    expect(creates(f)).toHaveLength(0); expect(f.shapeCalls.n).toBe(1);
    expect(text(f)).toMatch(/already/i); expect(text(f)).toContain('ENG-1');
    expect(await run(f, { force: true })).toBe(0);
    expect(creates(f)).toHaveLength(2); expect(f.shapeCalls.n).toBe(2);
  });
  it('a failed create is recorded as it happened; the rerun creates only the missing one from the same plan', async () => {
    const f = fixture();
    f.failNext.n = 0;
    // first create ok, second fails: fail after one success
    const real = f.deps.fetch; let seen = 0;
    f.deps.fetch = (async (u: string, i?: { body?: string }) => { if ((i?.body ?? '').includes('issueCreate') && ++seen === 2) return new Response('{}', { status: 500 }); return (real as unknown as (u: string, i?: unknown) => Promise<Response>)(u, i); }) as unknown as typeof fetch;
    expect(await run(f)).toBe(1);
    expect(text(f)).toContain('ENG-1');
    f.deps.fetch = real; f.calls.length = 0;
    expect(await run(f)).toBe(0);
    expect(creates(f)).toHaveLength(1);
    expect(f.shapeCalls.n).toBe(1);
    expect(JSON.parse(creates(f)[0]!.body).variables.input.title).toBe('Migrate login route');
  });
});

describe('refusals send nothing', () => {
  it('no credentials: names the connect command, no shaping, no request', async () => {
    const f = fixture(); f.creds['linear'] = null;
    expect(await run(f)).toBe(1);
    expect(text(f)).toContain('align connect linear');
    expect(f.shapeCalls.n).toBe(0); expect(f.calls).toHaveLength(0);
  });
  it('no model: says so, invents nothing', async () => {
    const f = fixture(); f.model.current = { ok: false, message: 'No LLM configured.' };
    expect(await run(f)).toBe(1);
    expect(text(f)).toContain('No LLM configured.'); expect(f.calls).toHaveLength(0);
  });
  it('unreadable model output: refuses', async () => {
    const f = fixture(); f.model.current = { ok: true, text: 'sure, here are some tasks!' };
    expect(await run(f)).toBe(1); expect(f.calls).toHaveLength(0); expect(fs.existsSync(f.deps.ledgerPath)).toBe(false);
  });
  it('two teams and no --team: non-TTY exits 2 naming --team', async () => {
    const f = fixture();
    expect(await run(f, { team: undefined })).toBe(2);
    expect(text(f)).toContain('--team'); expect(creates(f)).toHaveLength(0);
  });
  it('two teams and no --team: a TTY is asked once', async () => {
    const f = fixture(); f.deps.interactive = true;
    expect(await run(f, { team: undefined })).toBe(0);
    expect(f.asks).toHaveLength(1); expect(creates(f)).toHaveLength(2);
  });
  it('two credentials and no --tracker: non-TTY exits 2 naming --tracker', async () => {
    const f = fixture(); f.creds['github'] = { token: 'g' };
    expect(await run(f, { tracker: undefined })).toBe(2);
    expect(text(f)).toContain('--tracker'); expect(f.calls).toHaveLength(0);
  });
  it('github with no --repo: non-TTY exits 2 naming --repo', async () => {
    const f = fixture(); f.creds['github'] = { token: 'g' };
    expect(await run(f, { tracker: 'github', team: undefined })).toBe(2);
    expect(text(f)).toContain('--repo');
  });
  it('a credential that cannot create issues: says so and records nothing', async () => {
    const f = fixture(); f.failNext = { n: 5, status: 403 };
    expect(await run(f)).toBe(1);
    expect(text(f)).toMatch(/cannot create issues|write/i);
    expect(creates(f)).toHaveLength(1); // stops at the first refusal rather than hammering the rest
    const rows = Object.values(JSON.parse(fs.readFileSync(f.deps.ledgerPath, 'utf8')) as Record<string, { tasks: Array<{ key?: string }> }>);
    expect(rows).toHaveLength(1); expect(rows[0]!.tasks.every((t) => t.key === undefined)).toBe(true);
  });
  it('a search with several hits: non-TTY exits 2 asking for an id', async () => {
    const f = fixture(); f.deps.search = async () => [DEC, { ...DEC, id: '3f2a9c1e-0000-4000-8000-000000000002' }];
    expect(await run(f, { decision: 'oidc' })).toBe(2);
    expect(text(f)).toMatch(/decision id/i); expect(f.calls).toHaveLength(0);
  });
});

describe('lost responses, keys and the ledger file', () => {
  it('no answer from the tracker: says the issue may exist, stops, and warns on the rerun', async () => {
    const f = fixture(); const real = f.deps.fetch;
    f.deps.fetch = (async (u: string, i?: { body?: string }) => { if ((i?.body ?? '').includes('issueCreate')) throw new Error('timeout'); return (real as unknown as (u: string, i?: unknown) => Promise<Response>)(u, i); }) as unknown as typeof fetch;
    expect(await run(f)).toBe(1);
    expect(text(f)).toMatch(/may or may not have been created/);
    f.deps.fetch = real; f.out.length = 0;
    expect(await run(f)).toBe(0);
    expect(text(f)).toMatch(/Check first/);
  });
  it('team case does not split the ledger: eng after ENG creates nothing', async () => {
    const f = fixture(); await run(f); f.calls.length = 0;
    expect(await run(f, { team: 'eng' })).toBe(0);
    expect(creates(f)).toHaveLength(0);
  });
  it('the same Jira project on another site is a different destination', async () => {
    const f = fixture(); f.creds['jira'] = { token: 't', email: 'a@b.co', domain: 'acme.atlassian.net' };
    await run(f, { tracker: 'jira', team: undefined, project: 'PRJ' });
    f.creds['jira'] = { token: 't', email: 'a@b.co', domain: 'other.atlassian.net' }; f.calls.length = 0;
    expect(await run(f, { tracker: 'jira', team: undefined, project: 'PRJ' })).toBe(0);
    expect(creates(f)).toHaveLength(2);
  });
  it('a ledger file that is a JSON array stops the run instead of losing the entry', async () => {
    const f = fixture(); fs.writeFileSync(f.deps.ledgerPath, '[]');
    expect(await run(f)).toBe(1);
    expect(creates(f)).toHaveLength(0); expect(text(f)).toContain('not the expected shape');
  });
  it('a Linear 200 with errors is a refusal, not a created issue', async () => {
    const f = fixture(); const real = f.deps.fetch;
    f.deps.fetch = (async (u: string, i?: { body?: string }) => (i?.body ?? '').includes('issueCreate') ? new Response(JSON.stringify({ errors: [{ message: 'Team archived' }] })) : (real as unknown as (u: string, i?: unknown) => Promise<Response>)(u, i)) as unknown as typeof fetch;
    expect(await run(f)).toBe(1); expect(text(f)).toContain('Team archived');
  });
});

describe('shaping output', () => {
  it('model text cannot ping people or load images in the tracker', async () => {
    const f = fixture(); f.model.current = { ok: true, text: JSON.stringify({ tasks: [{ title: 'Ask @alice', body: 'cc @org/team ![x](https://evil.test/p.png) done' }] }) };
    await run(f);
    const sent = JSON.parse(creates(f)[0]!.body).variables.input as { title: string; description: string };
    expect(sent.description).not.toMatch(/@[A-Za-z]/); expect(sent.description).not.toContain('evil.test'); expect(sent.title).not.toMatch(/@[A-Za-z]/);
  });
  it('strips em dashes', async () => {
    const f = fixture(); f.model.current = { ok: true, text: JSON.stringify({ tasks: [{ title: 'Add config — now', body: 'a—b' }] }) };
    await run(f, { dryRun: true });
    expect(text(f)).not.toContain('—'); expect(text(f)).toContain('Add config - now');
  });
  it('cuts to --max and says so', async () => {
    const f = fixture(); f.model.current = { ok: true, text: JSON.stringify({ tasks: Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, body: 'b' })) }) };
    await run(f, { dryRun: true, max: 5 });
    expect(text(f)).toContain('5 issues'); expect(text(f)).toMatch(/12.*5|cut/i);
  });
});
