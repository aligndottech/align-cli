import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BacklogOptions, NeedsChoice, resolveBacklog, runBacklog } from '../lib/backlog/run.js';
import { creates, DEC, type Fx, fixture as makeFixture, text } from './helpers/backlog-fixture.js';

/**
 * Test List, `align backlog` (a person-run command: one decision -> one issue per task, created straight away):
 * - dry-run: prints tracker, target and N issues; creates nothing (it may read the Linear workspace name); writes no ledger row.
 * - linear: one issueCreate per task, team resolved from --team, description links back to the decision and its source.
 * - github and jira: one create per task against the repo / project given.
 * - idempotent: a second run on the same decision + target creates nothing; --force creates again.
 * - resume: a create that fails mid-run is recorded as it happened; the rerun creates only the missing ones from the SAME plan.
 * - missing credentials: exit 1, names the connect command, no shaping call, no request.
 * - missing model: exit 1, no tasks invented, no request. Unreadable model output: same.
 * - ambiguous target (2 teams) or tracker (2 credentials): non-TTY exits 2 naming the flag; TTY asks once.
 * - a credential that cannot create issues (403): exit 1 saying so, nothing recorded.
 * - model text has no em dashes; more tasks than --max are cut and said so.
 * Added with the seamless follow-up:
 * - saved target: a successful run saves tracker + destination; the next run with no flags uses it with no question and says so;
 *   a flag overrides (and becomes the new default); a dry run or a failed run saves nothing; a saved target whose tracker has no
 *   credential, or a saved destination for another tracker, is never applied.
 * - lock: two concurrent runs on one decision create one set of issues, not two; a lock left by a dead process does not block.
 * - the Linear workspace is part of the ledger key (the same team key in another workspace is another destination).
 * - structured choices (the MCP caller): an ambiguous tracker, team or decision comes back as options, creating nothing.
 */
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-backlog-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const fixture = (): Fx => makeFixture(dir);
const run = (f: Fx, o: Partial<BacklogOptions> = {}) => runBacklog({ decision: '3f2a9c1e-0000-4000-8000-000000000001', tracker: 'linear', team: 'ALI', ...o }, f.deps);

describe('dry-run', () => {
  it('prints tracker, target and count, creates nothing and writes no ledger', async () => {
    const f = fixture();
    expect(await run(f, { dryRun: true })).toBe(0);
    expect(creates(f)).toHaveLength(0); // reads (the workspace name) are allowed; writes are not
    expect(fs.existsSync(f.deps.ledgerPath)).toBe(false);
    expect(f.saved.writes).toHaveLength(0);
    expect(text(f)).toMatch(/Linear/); expect(text(f)).toContain('ALI'); expect(text(f)).toContain('2 issues');
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
    expect(text(f)).toContain('ALI-1'); expect(text(f)).toContain('ALI-2');
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
    expect(text(f)).toMatch(/already/i); expect(text(f)).toContain('ALI-1');
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
    expect(text(f)).toContain('ALI-1');
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
    expect(text(f)).toContain('No LLM configured.'); expect(creates(f)).toHaveLength(0);
  });
  it('unreadable model output: refuses', async () => {
    const f = fixture(); f.model.current = { ok: true, text: 'sure, here are some tasks!' };
    expect(await run(f)).toBe(1); expect(creates(f)).toHaveLength(0); expect(fs.existsSync(f.deps.ledgerPath)).toBe(false);
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
  it('team case does not split the ledger: ali after ALI creates nothing', async () => {
    const f = fixture(); await run(f); f.calls.length = 0;
    expect(await run(f, { team: 'ali' })).toBe(0);
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

describe('a saved target', () => {
  it('a successful run saves tracker and destination, and says how to change it', async () => {
    const f = fixture();
    expect(await run(f)).toBe(0);
    expect(f.saved.writes).toEqual([{ tracker: 'linear', target: 'ALI' }]);
    expect(text(f)).toMatch(/Saved Linear ALI as the default/); expect(text(f)).toMatch(/--team/);
  });
  it('a dry run and a failed run save nothing', async () => {
    const f = fixture();
    await run(f, { dryRun: true });
    f.failNext = { n: 5, status: 500 };
    expect(await run(f)).toBe(1);
    expect(f.saved.writes).toHaveLength(0);
  });
  it('the next run with no flags uses it without a question, even with two trackers connected, and says which', async () => {
    const f = fixture(); f.creds['github'] = { token: 'g' };
    f.saved.current = { tracker: 'linear', target: 'ALI' }; f.deps.interactive = true;
    expect(await run(f, { tracker: undefined, team: undefined })).toBe(0);
    expect(f.asks).toHaveLength(0);
    expect(creates(f)).toHaveLength(2);
    expect(text(f)).toMatch(/Using your saved target: Linear ALI/);
  });
  it('and non-interactively too: no flag is needed once a target is saved', async () => {
    const f = fixture(); f.creds['github'] = { token: 'g' }; f.saved.current = { tracker: 'linear', target: 'ALI' };
    expect(await run(f, { tracker: undefined, team: undefined })).toBe(0);
    expect(creates(f)).toHaveLength(2);
  });
  it('a flag overrides it and becomes the new default', async () => {
    const f = fixture(); f.saved.current = { tracker: 'linear', target: 'ALI' };
    expect(await run(f, { team: 'OPS' })).toBe(0);
    expect(text(f)).toContain('(OPS)'); expect(text(f)).not.toMatch(/Using your saved target/);
    expect(f.saved.writes).toEqual([{ tracker: 'linear', target: 'OPS' }]);
  });
  it('a saved destination is never applied to a different tracker', async () => {
    const f = fixture(); f.creds['github'] = { token: 'g' }; f.saved.current = { tracker: 'linear', target: 'ALI' };
    expect(await run(f, { tracker: 'github', team: undefined })).toBe(2);
    expect(text(f)).toContain('--repo'); expect(f.calls).toHaveLength(0);
  });
  it('a saved tracker with no credential any more is ignored, not trusted', async () => {
    const f = fixture(); f.creds['linear'] = null; f.creds['github'] = { token: 'g' };
    f.saved.current = { tracker: 'linear', target: 'ALI' };
    expect(await run(f, { tracker: undefined, team: undefined, repo: 'o/r' })).toBe(0);
    expect(text(f)).toContain('GitHub Issues (o/r)'); expect(text(f)).not.toMatch(/Using your saved target/);
  });
});

describe('two runs at once', () => {
  it('create one set of issues between them, and the loser says why it stopped', async () => {
    const f = fixture(); const g = fixture();
    g.deps.ledgerPath = f.deps.ledgerPath; g.deps.fetch = f.deps.fetch;
    const [a, b] = await Promise.all([run(f), run(g)]);
    expect([a, b].sort()).toEqual([0, 1]);
    expect(creates(f)).toHaveLength(2);
    expect([...g.err, ...f.err].join('\n')).toMatch(/already running/i);
    // The loser's rerun finds the winner's work and creates nothing.
    expect(await run(g)).toBe(0); expect(creates(f)).toHaveLength(2);
  });
  it('a lock left behind by a process that no longer exists does not block', async () => {
    const f = fixture();
    fs.writeFileSync(`${f.deps.ledgerPath}.lock`, JSON.stringify({ pid: 2_147_483_646, at: new Date().toISOString() }));
    expect(await run(f)).toBe(0); expect(creates(f)).toHaveLength(2);
    expect(fs.existsSync(`${f.deps.ledgerPath}.lock`)).toBe(false);
  });
  it('the lock is released when a run fails', async () => {
    const f = fixture(); f.model.current = { ok: false, message: 'No LLM configured.' };
    await run(f);
    expect(fs.existsSync(`${f.deps.ledgerPath}.lock`)).toBe(false);
  });
});

describe('the Linear workspace is part of the destination', () => {
  it('the same team key in another workspace is created again; the same workspace is not', async () => {
    const f = fixture();
    await run(f); f.calls.length = 0;
    expect(await run(f)).toBe(0); expect(creates(f)).toHaveLength(0);
    f.workspace.current = 'other-co';
    expect(await run(f)).toBe(0); expect(creates(f)).toHaveLength(2);
  });
});

describe('structured choices for a caller that cannot be asked (MCP)', () => {
  const ask = (f: Fx, o: Partial<BacklogOptions> = {}) => resolveBacklog({ decision: DEC.id, structuredChoices: true, ...o }, f.deps);
  it('two trackers and no saved target: the tracker options, nothing sent', async () => {
    const f = fixture(); f.creds['github'] = { token: 'g' };
    const e = await ask(f).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NeedsChoice);
    expect((e as NeedsChoice).choice).toMatchObject({ field: 'tracker', options: [{ value: 'linear' }, { value: 'github' }] });
    expect(f.calls).toHaveLength(0);
  });
  it('two teams: the team list, with keys and names', async () => {
    const f = fixture();
    const e = await ask(f).catch((x: unknown) => x);
    expect((e as NeedsChoice).choice).toMatchObject({ field: 'team', options: [{ value: 'ALI', label: 'ALI  Align' }, { value: 'OPS', label: 'OPS  Ops' }] });
  });
  it('github with no repo: a free-text question with no options', async () => {
    const f = fixture(); f.creds['github'] = { token: 'g' };
    const e = await ask(f, { tracker: 'github' }).catch((x: unknown) => x);
    expect((e as NeedsChoice).choice).toMatchObject({ field: 'repo', options: [] });
  });
  it('search words with several hits: the decisions to choose from; with one hit it is used', async () => {
    const f = fixture(); f.deps.search = async () => [DEC, { ...DEC, id: '3f2a9c1e-0000-4000-8000-000000000002', title: 'Other' }];
    const e = await ask(f, { decision: 'oidc', team: 'ALI' }).catch((x: unknown) => x);
    expect((e as NeedsChoice).choice).toMatchObject({ field: 'decision', options: [{ value: DEC.id }, { value: '3f2a9c1e-0000-4000-8000-000000000002' }] });
    f.deps.search = async () => [DEC];
    expect((await ask(f, { decision: 'oidc', team: 'ALI' })).dec.id).toBe(DEC.id);
  });
  it('the CLI wording is unchanged: the same ambiguity still says which flag to pass', async () => {
    const f = fixture(); f.creds['github'] = { token: 'g' };
    expect(await run(f, { tracker: undefined })).toBe(2); expect(text(f)).toContain('--tracker');
  });
});
