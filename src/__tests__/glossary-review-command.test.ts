/**
 * `align glossary review` is READ-ONLY.
 *
 * The gateway confirms or rejects an alias only for an interactive web login, and the web app has
 * the screen for it (/settings/glossary). So the CLI lists the proposed aliases, can ask the
 * gateway to propose more (`--bootstrap`, proposals only), and points the person at the web app.
 * It has no code path that confirms or rejects, and test 1 proves no such request is ever sent.
 *
 * Faked at the HTTP boundary only: the real gateway client runs and `fetch` answers with the shapes
 * glossaryRoutes.ts returns (list `{ aliases, omitted }`, bootstrap report, errors `{ error }`).
 * The config store is the disk boundary.
 *
 * Test List:
 *  1. every path (default, --list, --bootstrap, with and without a terminal) sends only GETs and
 *     the bootstrap POST: nothing to /confirm or /reject
 *  2. lists PROPOSED only, with the bearer, and prints each alias and its canonical
 *  3. the closing line names the web app's /settings/glossary, from the configured environment
 *     (a prod gateway and a local gateway give different links)
 *  4. a team destination's saved appUrl wins over the guess
 *  5. works without a terminal, since it only reads
 *  6. --bootstrap posts /glossary/bootstrap first, then lists
 *  7. a partial list (omitted > 0) says so
 *  8. nothing proposed: says so, exit 0, no pointer to a screen with nothing on it
 *  9. local mode: refuses with the cloud-only message
 * 10. a gateway error is reported and exits 1
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), stop: vi.fn(), fail: vi.fn(), succeed: vi.fn() })),
}));
const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('prod'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));
const getEnvironment = vi.hoisted(() => vi.fn());
vi.mock('../lib/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConfigStore: vi.fn(() => ({ getEnvironment })),
}));

import { registerGlossaryCommand } from '../commands/glossary.js';

const cloudEnv = { gatewayUrl: 'https://api.align.tech', authToken: 'tok_real', tenantId: 'tenant-123', mode: 'auth' as const };

const alias = (id: string, term: string, canonical: string) => ({
  id, alias: term, canonical, status: 'proposed', source: 'bootstrap',
  createdAt: '2026-10-20T10:00:00.000Z', approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null,
});
const A1 = alias('11111111-1111-4111-8111-111111111111', 'payments-svc', 'payments');
const A2 = alias('22222222-2222-4222-8222-222222222222', 'Falcon', 'checkout');

interface Call { method: string; url: string; headers: Record<string, string>; body?: string }
const calls: Call[] = [];
type Responder = (c: Call) => { status?: number; json: unknown } | undefined;
let responder: Responder;
const mockFetch = vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  const call: Call = { method: init.method ?? 'GET', url: String(url), headers: init.headers ?? {}, body: init.body };
  calls.push(call);
  const r = responder(call);
  if (!r) throw new Error(`unexpected request ${call.method} ${call.url}`);
  const status = r.status ?? 200;
  return { ok: status < 400, status, json: async () => r.json };
});
vi.stubGlobal('fetch', mockFetch);

const path = (c: Call) => c.url.replace(/^https?:\/\/[^/]+/, '');
const signature = (c: Call) => `${c.method} ${path(c)}`;

const out: string[] = [];
const err: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
let exitCode: number | undefined;
vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  exitCode = code;
  throw new Error(`process.exit(${code})`);
}) as never);

async function run(args: string[]): Promise<void> {
  out.length = 0; err.length = 0; exitCode = undefined; calls.length = 0;
  const program = new Command();
  program.exitOverride();
  registerGlossaryCommand(program);
  try {
    await program.parseAsync(['node', 'align', 'glossary', ...args]);
  } catch (e) {
    if (!/process\.exit/.test((e as Error).message)) throw e;
  }
}

const inTty = process.stdin.isTTY;
const setStdinTty = (value: boolean) => Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });

const bootstrapReport = { candidates: 5, proposed: 2, alreadyKnown: 3, overProposalCap: 0, signalRowsOmitted: { scopes: 0, teams: 0, repoMappings: 0 } };
const serve = (aliases: unknown[], omitted = 0): Responder => (c) => {
  if (c.method === 'GET' && path(c).startsWith('/glossary/aliases')) return { json: { aliases, omitted } };
  if (c.method === 'POST' && path(c) === '/glossary/bootstrap') return { json: bootstrapReport };
  return undefined;
};

beforeEach(() => {
  mockFetch.mockClear();
  getEnvironment.mockReset().mockReturnValue(cloudEnv);
  resolveEnv.mockReset().mockReturnValue('prod');
  responder = serve([A1, A2]);
  setStdinTty(inTty as boolean);
});

describe('align glossary review never confirms or rejects', () => {
  it('1. no invocation sends anything to /confirm or /reject, and the only POST is the bootstrap', async () => {
    for (const args of [['review'], ['review', '--list'], ['review', '--bootstrap'], ['review', '--list', '--bootstrap']]) {
      for (const tty of [true, false]) {
        setStdinTty(tty);
        await run(args);
        expect(calls.length).toBeGreaterThan(0); // the command ran and talked to the gateway
        for (const c of calls) {
          expect(path(c)).not.toMatch(/\/(confirm|reject)/);
          if (c.method === 'POST') expect(path(c)).toBe('/glossary/bootstrap');
        }
      }
    }
  });
});

describe('align glossary review lists what is waiting', () => {
  it('2. fetches PROPOSED aliases with the bearer and prints each alias with its canonical', async () => {
    await run(['review']);
    expect(exitCode).toBeUndefined();
    expect(calls.map(signature)).toEqual(['GET /glossary/aliases?status=proposed']);
    expect(calls[0]!.headers['Authorization']).toBe('Bearer tok_real');
    const text = out.join('\n');
    expect(text).toContain('"payments-svc" means "payments"');
    expect(text).toContain('"Falcon" means "checkout"');
    expect(text).toMatch(/2 proposed aliases/);
  });

  it('3. ends with a line pointing at the web app /settings/glossary, derived from the configured environment', async () => {
    await run(['review']);
    expect(out.join('\n')).toContain('Confirm or reject them in the web app: https://app.align.tech/settings/glossary');

    getEnvironment.mockReturnValue({ ...cloudEnv, gatewayUrl: 'http://localhost:8080' });
    await run(['review']);
    expect(out.join('\n')).toContain('http://localhost:5173/settings/glossary');
    expect(out.join('\n')).not.toContain('app.align.tech');
  });

  it('4. a team destination saved appUrl wins over the guess from the gateway address', async () => {
    getEnvironment.mockReturnValue({ ...cloudEnv, kind: 'team', gatewayUrl: 'https://gw.acme.example', appUrl: 'https://align.acme.example/' });
    await run(['review']);
    expect(out.join('\n')).toContain('https://align.acme.example/settings/glossary');
  });

  it('5. works without a terminal, because it only reads', async () => {
    setStdinTty(false);
    await run(['review']);
    expect(exitCode).toBeUndefined();
    expect(out.join('\n')).toContain('payments-svc');
  });

  it('6. --bootstrap posts /glossary/bootstrap first, then lists', async () => {
    await run(['review', '--bootstrap']);
    expect(calls.map(signature)).toEqual(['POST /glossary/bootstrap', 'GET /glossary/aliases?status=proposed']);
    expect(out.join('\n')).toMatch(/2 new/);
  });

  it('7. a partial list (omitted > 0) says how many were left out', async () => {
    responder = serve([A1], 7);
    await run(['review']);
    expect(out.join('\n')).toMatch(/7 more not shown/);
  });

  it('8. nothing proposed: says so, exits 0, and sends no pointer to a screen with nothing on it', async () => {
    responder = serve([]);
    await run(['review']);
    expect(exitCode).toBeUndefined();
    expect(out.join('\n')).toMatch(/nothing to review/i);
    expect(out.join('\n')).not.toContain('/settings/glossary');
  });

  it('9. local mode: refuses with the cloud-only message and sends nothing', async () => {
    getEnvironment.mockReturnValue({ mode: 'local-embedded', localDbPath: ':memory:' });
    await run(['review']);
    expect(exitCode).toBe(1);
    expect(err.join('\n') + out.join('\n')).toMatch(/not available in local mode/);
    expect(calls).toHaveLength(0);
  });

  it('10. a gateway error is reported and exits 1', async () => {
    responder = (c) => (c.method === 'GET' ? { status: 500, json: { error: 'boom' } } : undefined);
    await run(['review']);
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/boom|500/);
  });
});
