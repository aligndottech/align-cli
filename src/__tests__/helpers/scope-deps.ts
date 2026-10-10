/**
 * L4 test helpers: an in-memory scope store, scripted vendor responses keyed by URL, and the `ScopeDeps` that glue them to a
 * graph path. Shared by the scope, align_scope and connect-scope suites so they exercise the real scope code against fakes.
 */
import type { ScopeDeps, ScopeStore } from '../../lib/scope.js';
import type { StoredScope } from '../../lib/scope-values.js';

export const TOKEN = 'SECRET-TOKEN-0123456789';
export const NOW = new Date('2026-10-10T12:00:00.000Z');

export const FIELDS: Record<string, Record<string, string>> = {
  github: { token: TOKEN }, jira: { token: TOKEN, email: 'me@acme.com', domain: 'acme.atlassian.net' },
  confluence: { token: TOKEN, email: 'me@acme.com', domain: 'acme.atlassian.net' }, linear: { token: 'lin_api_abc' },
  gitlab: { token: TOKEN }, zoom: { token: TOKEN }, slack: { token: TOKEN }, notion: { token: TOKEN }, teams: { token: TOKEN },
};

export type MemStore = ScopeStore & { scopes: Record<string, StoredScope>; disclosed: Set<string> };

export function memStore(init: { connected?: string[]; scopes?: Record<string, StoredScope>; disclosed?: string[] } = {}): MemStore {
  const connected = new Set(init.connected ?? Object.keys(FIELDS));
  const scopes = { ...(init.scopes ?? {}) };
  const disclosed = new Set(init.disclosed ?? []);
  return {
    scopes, disclosed,
    getScope: (s) => scopes[s] ?? null,
    saveScope: (s, v) => { scopes[s] = v; },
    clearScope: (s) => { delete scopes[s]; },
    fields: (s) => (connected.has(s) ? FIELDS[s] ?? null : null),
    isDisclosed: (s) => disclosed.has(s),
    markDisclosed: (s) => { disclosed.add(s); },
  };
}

export type Route = [RegExp, { status?: number; body?: unknown } | Error];

export function routes(table: Route[]): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string | URL | Request): Promise<Response> => {
    calls.push(String(url));
    const hit = table.find(([re]) => re.test(String(url)));
    if (!hit) return new Response('{}', { status: 404 });
    if (hit[1] instanceof Error) throw hit[1];
    return new Response(JSON.stringify(hit[1].body ?? {}), { status: hit[1].status ?? 200 });
  };
  return { fetch: f as unknown as typeof fetch, calls };
}

export type TestDeps = ScopeDeps & { store: MemStore; calls: string[] };

export function makeDeps(dbPath: string | undefined, over: Partial<ScopeDeps> & { store?: MemStore; table?: Route[] } = {}): TestDeps {
  const r = routes(over.table ?? []);
  const store = over.store ?? memStore();
  return {
    dbPath, now: () => NOW, cwdRepo: async () => undefined, cwdGitlabProject: async () => undefined, fetch: r.fetch, ...over, store, calls: r.calls,
  } as TestDeps;
}

export const jiraProjects = (...keys: string[]): Route => [/rest\/api\/3\/project\/search/, { body: { values: keys.map((key) => ({ key, name: key })), isLast: true } }];
