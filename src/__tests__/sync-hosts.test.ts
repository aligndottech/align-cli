import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async () => new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { runSync } from '../lib/sync/run-all.js';
import { fetchSource } from '../lib/sync/sources.js';
import { type Harness, harness } from './helpers/sync-env.js';

/**
 * L5 (Decision 10): a sync talks only to the vendor hosts of the sources it syncs. Run the REAL GitHub
 * fetcher and the real discussion drain over a mocked network, record every host the process asked for, and
 * compare with the connected set. A negative control shows the guard names an offending host.
 */
vi.setConfig({ testTimeout: 60_000 });
const VENDOR_HOSTS: Record<string, string[]> = { github: ['api.github.com'] };

/** Throws, naming the first host that is not a vendor host of a connected source. */
export function assertOnlyVendorHosts(requested: readonly string[], connected: readonly string[]): void {
  const allowed = new Set(connected.flatMap((s) => VENDOR_HOSTS[s] ?? []));
  const stray = requested.find((h) => !allowed.has(h));
  if (stray !== undefined) throw new Error(`a sync asked for host ${stray}, which is not a vendor host of ${connected.join(', ')}`);
}

let h: Harness;
let hosts: string[];
let agent: MockAgent;
beforeEach(() => {
  hosts = [];
  h = harness();
  agent = new MockAgent();
  agent.disableNetConnect();
  // Every request the process makes goes through this dispatcher, mocked or not, so the host is
  // recorded BEFORE a mock can match or refuse it: an unexpected host cannot hide behind a swallowed error.
  const dispatch = agent.dispatch.bind(agent);
  agent.dispatch = ((opts: { origin?: string | URL }, handler: never) => {
    hosts.push(new URL(String(opts.origin)).host);
    return dispatch(opts as never, handler);
  }) as typeof agent.dispatch;
  const api = agent.get('https://api.github.com');
  const json = { headers: { 'content-type': 'application/json' } };
  const row = (n: number) => ({
    number: n, title: `PR ${n}`, body: 'Use a queue', state: 'open', html_url: `https://github.com/o/r/pull/${n}`,
    repository_url: 'https://api.github.com/repos/o/r', pull_request: { merged_at: null },
    user: { login: 'me', html_url: 'https://github.com/me' }, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
  });
  api.intercept({ path: '/user' }).reply(200, { login: 'me' }, json).persist();
  api.intercept({ path: (p) => p.startsWith('/search/issues') && decodeURIComponent(p).includes('type:pr') }).reply(200, { total_count: 2, items: [row(1), row(2)] }, json).persist();
  api.intercept({ path: (p) => p.startsWith('/search/issues') }).reply(200, { total_count: 0, items: [] }, json).persist();
  api.intercept({ path: (p) => p.includes('/comments') }).reply(200, [], json).persist();
  api.intercept({ path: (p) => p.startsWith('/repos/o/r/pulls/') }).reply(200, [], json).persist();
  setGlobalDispatcher(agent);
});
afterEach(async () => {
  await agent.close();
  h.cleanup();
});

describe('which hosts a sync talks to', () => {
  it('a real GitHub sync (list read, discussion drain) asks only for api.github.com', async () => {
    // The harness stubs the drain; this test wants the real one, so its requests are counted too.
    const env = { ...h.env, fetch: fetchSource, drain: undefined };
    const r = await runSync(['github'], env, { trigger: 'background' });
    expect(r.outcomes[0]).toMatchObject({ state: expect.stringMatching(/ok|partial/), created: 2 });
    expect(r.outcomes[0]!.drain).toMatchObject({ enriched: 2 }); // the drain really ran: positive control that requests were made
    expect(hosts.length).toBeGreaterThan(3);
    expect(() => assertOnlyVendorHosts(hosts, ['github'])).not.toThrow();
  });

  it('negative control: a fetcher that phones align.tech fails the guard, naming the host', () => {
    expect(() => assertOnlyVendorHosts(['api.github.com', 'align.tech'], ['github'])).toThrow(/host align\.tech/);
    expect(() => assertOnlyVendorHosts(['api.github.com'], ['jira'])).toThrow(/host api\.github\.com/);
  });
});
