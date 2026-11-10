import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../lib/config.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { resolveScope } from '../lib/scope.js';
import { findConfluencePage } from '../lib/scope-choices.js';
import { type ConnectScopeCtx, decideConnectScope, type PickOption } from '../lib/scope-connect.js';
import { makeDeps, memStore, type Route } from './helpers/scope-deps.js';

vi.mock('conf', () => {
  let store: Record<string, unknown> = {};
  return {
    default: class {
      private defaults: Record<string, unknown>;
      constructor(opts: { defaults?: Record<string, unknown> }) { this.defaults = opts.defaults ?? {}; store = JSON.parse(JSON.stringify(this.defaults)); }
      get(k: string) { return store[k]; }
      set(k: string, v: unknown) { store[k] = v; }
      has(k: string) { return k in store; }
      delete(k: string) { delete store[k]; }
      clear() { store = JSON.parse(JSON.stringify(this.defaults)); }
    },
  };
});
const identity = vi.hoisted(() => vi.fn<() => string | null>());
vi.mock('../lib/repo-identity.js', async (orig) => ({ ...(await orig<object>()), currentRepoIdentitySync: identity }));
import { configScopeStore, scopeRepoKey } from '../lib/scope-real.js';

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const raw = (cfg: ReturnType<typeof createConfigStore>, source: string, v: unknown): void => cfg.setConnectorToken('local', `${source}:scope`, JSON.stringify(v));

describe('stored page scopes never widen', () => {
  let cfg: ReturnType<typeof createConfigStore>;
  beforeEach(() => { cfg = createConfigStore(); cfg.forgetAllConnectors('local'); });

  it('a Notion narrowed entry whose narrowing cannot be read is blocked with the command, not read as everything shared', async () => {
    raw(cfg, 'notion', { kind: 'narrowed', values: [P1], labels: [P1], narrow: { by: 'pages', ids: 'oops' } });
    const store = configScopeStore(cfg, () => null);
    const r = await resolveScope('notion', makeDeps(undefined, { store: { ...memStore(), getScope: store.getScope } }), { foreground: false });
    expect(r.blocked).toContain('align connect --source notion');
    expect(r.extras).toEqual({});
  });

  it('a stored narrowing with an invalid id drops the id; none valid left means unreadable, and the bad id is never echoed', () => {
    raw(cfg, 'notion', { kind: 'narrowed', values: [P1], labels: [P1], narrow: { by: 'pages', ids: [P1, 'bad id; x'], names: ['A', 'B'] } });
    const s = configScopeStore(cfg, () => null).getScope('notion');
    expect(JSON.stringify(s)).not.toContain('bad id');
    raw(cfg, 'confluence', { kind: 'narrowed', values: ['ENG'], labels: ['ENG'], narrow: { by: 'ancestors', ids: ['12', 'x1'], names: ['A', 'B'] } });
    const c = configScopeStore(cfg, () => null).getScope('confluence');
    expect(c).toMatchObject({ kind: 'team', narrow: { by: 'ancestors', ids: ['12'], names: ['A'] } });
  });
});

describe('Notion first connect', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-r2-')); createLocalGatewayClient(path.join(dir, 'g.db')).close(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const table: Route[] = [[/api\.notion\.com\/v1\/search/, { body: { results: [
    { object: 'page', id: P2, properties: { Name: { type: 'title', title: [{ plain_text: 'Hiring' }] } } },
    { object: 'page', id: P1, properties: { Name: { type: 'title', title: [{ plain_text: 'align-cli roadmap' }] } } },
  ], has_more: false } }]];

  it('with nothing stored nothing is preselected, and the matching page is listed first', async () => {
    const asked: Array<{ options: PickOption[]; initial: string[] }> = [];
    const ctx: ConnectScopeCtx = {
      deps: makeDeps(path.join(dir, 'g.db'), { table }), interactive: true, quiet: false, flags: {},
      prompts: { multiselect: async (_m, options, initial) => { asked.push({ options, initial }); return initial; }, confirm: async () => false },
      citedKeys: () => [], say: () => {}, repoNames: () => ['align-cli'], inRepo: () => true,
    };
    const d = await decideConnectScope('notion', { token: 't' }, ctx);
    expect(asked[0]!.initial).toEqual([]);
    expect(asked[0]!.options.map((o) => o.value)).toEqual([':skip', P1, P2]);
    expect(d.extras).toEqual({ resolved: true });
  });
});

describe('scopeRepoKey retries what it could not answer', () => {
  it('a null is asked again next time; a real identity is not', () => {
    identity.mockReset();
    const spy = vi.spyOn(process, 'cwd').mockReturnValue('/work/retry');
    identity.mockReturnValueOnce(null).mockReturnValue('github.com/a/b');
    expect(scopeRepoKey({})).toBeNull();
    expect(scopeRepoKey({})).toBe('github.com/a/b');
    expect(scopeRepoKey({})).toBe('github.com/a/b');
    expect(identity).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('one page-id pattern', () => {
  it('findConfluencePage accepts a 13+ digit id', async () => {
    const f = (async () => new Response(JSON.stringify({ title: 'T' }), { status: 200 })) as unknown as typeof fetch;
    expect(await findConfluencePage({ token: 't', email: 'e', domain: 'a.atlassian.net' }, '1234567890123', f)).toEqual({ title: 'T' });
  });
});
