import path from 'node:path';
import type { BacklogDeps, BacklogOptions, DecisionInput } from '../../lib/backlog/run.js';
import type { SavedTarget } from '../../lib/backlog/targets.js';

/** One fake world for every backlog test: HTTP is faked at fetch and nothing else. Linear by default; two teams; model text scripted. */
export const DEC: DecisionInput = { id: '3f2a9c1e-0000-4000-8000-000000000001', title: 'Move auth to OIDC', summary: 'We use OIDC for all logins.', sourceUrl: 'https://github.com/o/r/pull/9', actions: ['Add OIDC provider config'] };
export const TASKS = JSON.stringify({ tasks: [{ title: 'Add OIDC provider config', body: 'Wire the provider.' }, { title: 'Migrate login route', body: 'Switch the route.' }] });

export interface Fx { out: string[]; err: string[]; calls: Array<{ url: string; body: string }>; shapeCalls: { n: number }; deps: BacklogDeps; asks: string[]; model: { current: { ok: true; text: string } | { ok: false; message: string } }; creds: Record<string, Record<string, string> | null>; failNext: { n: number; status: number }; workspace: { current: string }; saved: { current: SavedTarget | undefined; writes: SavedTarget[] } }

export function fixture(dir: string): Fx {
  const f = { out: [] as string[], err: [] as string[], calls: [] as Array<{ url: string; body: string }>, shapeCalls: { n: 0 }, asks: [] as string[],
    model: { current: { ok: true, text: TASKS } as Fx['model']['current'] },
    creds: { linear: { token: 'lin_api_x' }, github: null, jira: null } as Fx['creds'], failNext: { n: 0, status: 500 },
    workspace: { current: 'acme' }, saved: { current: undefined as SavedTarget | undefined, writes: [] as SavedTarget[] } };
  let n = 0;
  const fetchFake = (async (url: string, init?: { body?: string }) => {
    const body = init?.body ?? '';
    f.calls.push({ url, body });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.includes('api.linear.app')) {
      if (body.includes('organization')) return json({ data: { organization: { urlKey: f.workspace.current } } });
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
    savedTarget: () => f.saved.current,
    saveTarget: (t) => { f.saved.current = t; f.saved.writes.push(t); },
    out: (l) => f.out.push(l), err: (l) => f.err.push(l),
  };
  return Object.assign(f, { deps }) as unknown as Fx;
}
export const creates = (f: Fx): Array<{ url: string; body: string }> => f.calls.filter((c) => c.body.includes('issueCreate') || c.url.includes('/issues') || c.url.includes('/rest/api/3/issue'));
export const text = (f: Fx): string => [...f.out, ...f.err].join('\n');
export type { BacklogOptions };
