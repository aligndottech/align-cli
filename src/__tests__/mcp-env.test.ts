import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveMcpEnvironment } from '../lib/mcp-env.js';

// `align mcp` on a machine where nothing was ever set up. Directories hand out
// `npx -y @aligndottech/cli mcp`, so this is often the very first command a person runs.
// Before: it served the hosted prod gateway with no login, so every tool description named
// https://api.align.tech and every call failed. Now: the local graph, as setup would make it.

type Env = { mode: string; authToken: string | null; gatewayUrl?: string; localDbPath?: string };

function store(opts: { defaultEnv?: string; local?: Partial<Env>; cloud?: Partial<Env>; destinations?: string[] } = {}) {
  const { defaultEnv = 'prod', local = {}, cloud = {}, destinations = [] } = opts;
  const writes: string[] = [];
  return {
    writes,
    getDefaultEnv: () => defaultEnv,
    getEnvironment: (e: string): Env =>
      e === 'local'
        ? { mode: 'demo', authToken: null, gatewayUrl: 'http://localhost:8080', ...local }
        : { mode: 'auth', authToken: null, gatewayUrl: 'https://api.align.tech', ...cloud },
    hasTeamDestination: (n: string) => destinations.includes(n),
    listTeamDestinationNames: () => destinations,
    setLocalMode: (p: string) => { writes.push(p); },
  };
}

const DB = '/home/u/.align/local.db';

describe('resolveMcpEnvironment', () => {
  const orig = process.env['ALIGN_ENV'];
  const origGw = process.env['ALIGN_GATEWAY_URL'];
  beforeEach(() => { delete process.env['ALIGN_ENV']; delete process.env['ALIGN_GATEWAY_URL']; });
  afterEach(() => {
    if (orig === undefined) delete process.env['ALIGN_ENV'];
    else process.env['ALIGN_ENV'] = orig;
    if (origGw === undefined) delete process.env['ALIGN_GATEWAY_URL'];
    else process.env['ALIGN_GATEWAY_URL'] = origGw;
  });

  it('serves the local graph on a machine with nothing set up', () => {
    const c = store();
    const r = resolveMcpEnvironment(undefined, c as never, DB);
    expect(r.name).toBe('local');
    expect(r.env.mode).toBe('local-embedded');
    expect(r.env.localDbPath).toBe(DB);
  });

  it('writes nothing to the config doing so: starting a server is not setup', () => {
    const c = store();
    resolveMcpEnvironment(undefined, c as never, DB);
    expect(c.writes).toEqual([]);
  });

  it('keeps a logged-in user on their team graph', () => {
    const r = resolveMcpEnvironment(undefined, store({ cloud: { authToken: 'tok' } }) as never, DB);
    expect(r.name).toBe('prod');
    expect(r.env.mode).toBe('auth');
  });

  it('an explicit --env always wins, even with no login', () => {
    const r = resolveMcpEnvironment('prod', store() as never, DB);
    expect(r.name).toBe('prod');
    expect(r.env.mode).toBe('auth');
  });

  it('ALIGN_ENV is respected the same way', () => {
    process.env['ALIGN_ENV'] = 'preview';
    const r = resolveMcpEnvironment(undefined, store() as never, DB);
    expect(r.name).toBe('preview');
  });

  it('leaves a demo-mode default alone', () => {
    const r = resolveMcpEnvironment(undefined, store({ cloud: { mode: 'demo' } }) as never, DB);
    expect(r.name).toBe('prod');
    expect(r.env.mode).toBe('demo');
  });

  it('a person who joined a team graph is not handed an empty local graph', () => {
    // `align join acme` saves a destination with its own token; the default stays prod with none.
    // Serving local here would make their agent report "no decisions" instead of reading the team's.
    const r = resolveMcpEnvironment(undefined, store({ destinations: ['acme'] }) as never, DB);
    expect(r.name).toBe('prod');
  });

  it('a set ALIGN_GATEWAY_URL is a chosen server, not "nothing set up"', () => {
    process.env['ALIGN_GATEWAY_URL'] = 'https://align.internal.example';
    const r = resolveMcpEnvironment(undefined, store() as never, DB);
    expect(r.name).toBe('prod');
  });

  it('an existing local graph keeps its saved path', () => {
    const saved = '/data/my.db';
    const r = resolveMcpEnvironment(undefined, store({ local: { mode: 'local-embedded', localDbPath: saved } }) as never, DB);
    expect(r.name).toBe('local');
    expect(r.env.localDbPath).toBe(saved);
  });
});
