/**
 * ALI-1578: `align glossary review` - a person confirms or rejects each PROPOSED alias.
 *
 * The gateway stores every alias as `proposed` (a person, an agent or the bootstrap wrote it) and
 * only a confirmed one is ever read to match a query. So the whole value of this command is that
 * nothing becomes confirmed without an explicit human action, and that holds here in two ways:
 * the command refuses a caller that is not at a terminal, and it only POSTs a confirm or reject
 * for the item the person chose it for.
 *
 * Faked at the HTTP boundary only: the real gateway client runs, `fetch` answers with the shapes
 * the gateway's glossaryRoutes.ts returns (list `{ aliases, omitted }`, confirm
 * `{ alias, already_confirmed }`, reject `{ alias }`, errors `{ error }`). The prompt library is the
 * terminal boundary, the config store is the disk boundary.
 *
 * Test List:
 *  1. stdin not a TTY: refuses, says why, makes no request at all
 *  2. lists PROPOSED only, with the bearer, and confirm / reject post to the chosen ids only
 *  3. skipping every item posts nothing (no default action exists)
 *  4. cancelling the prompt stops the walk and posts nothing further
 *  5. an id is encoded into the path
 *  6. 403 confirmation_requires_human: says the gateway wants a signed-in web session, stops
 *  7. 409 alias_would_not_apply: reports it and moves on to the next alias
 *  8. --bootstrap posts /glossary/bootstrap first, then lists, and still confirms nothing
 *  9. --list prints without a terminal and never posts
 * 10. a partial list (omitted > 0) says so
 * 11. nothing proposed: says so, exit 0
 * 12. local mode: refuses with the cloud-only message
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const CANCEL = Symbol('clack-cancel');
const select = vi.hoisted(() => vi.fn());
vi.mock('@clack/prompts', () => ({
  select,
  isCancel: (v: unknown) => typeof v === 'symbol',
}));
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

const alias = (id: string, term: string, canonical: string, status = 'proposed') => ({
  id, alias: term, canonical, status, source: 'bootstrap',
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

const posts = () => calls.filter((c) => c.method === 'POST');
const path = (c: Call) => c.url.replace('https://api.align.tech', '');

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

/** Serves the list for the proposed filter and records nothing else; tests override per case. */
const serveList = (aliases: unknown[], omitted = 0): Responder => (c) =>
  c.method === 'GET' && path(c).startsWith('/glossary/aliases') ? { json: { aliases, omitted } } : undefined;

beforeEach(() => {
  select.mockReset();
  mockFetch.mockClear();
  getEnvironment.mockReset().mockReturnValue(cloudEnv);
  resolveEnv.mockReset().mockReturnValue('prod');
  responder = serveList([A1, A2]);
  setStdinTty(true);
});
afterEach(() => setStdinTty(inTty as boolean));

describe('align glossary review is a human act', () => {
  it('1. a piped stdin (a hook, a pipe, an agent shell) refuses, says why, and sends nothing', async () => {
    setStdinTty(false);
    await run(['review']);
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toMatch(/terminal/i);
    expect(err.join('\n')).toMatch(/hook|pipe|agent/i);
    expect(calls).toHaveLength(0);
    expect(select).not.toHaveBeenCalled();
  });

  it('3. skipping every item posts nothing: there is no default action', async () => {
    select.mockResolvedValue('skip');
    await run(['review']);
    expect(exitCode).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(2);
    expect(posts()).toHaveLength(0);
    expect(out.join('\n')).toMatch(/0 confirmed/);
  });

  it('4. cancelling the prompt stops the walk: the second alias is never asked about or posted', async () => {
    select.mockResolvedValueOnce('confirm').mockResolvedValueOnce(CANCEL);
    responder = (c) => (c.method === 'POST' ? { json: { alias: A1, already_confirmed: false } } : serveList([A1, A2])(c));
    await run(['review']);
    expect(exitCode).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(2);
    expect(posts().map(path)).toEqual([`/glossary/aliases/${A1.id}/confirm`]);
  });
});

describe('align glossary review from a terminal', () => {
  it('2. lists proposed aliases with the bearer, then confirms the first and rejects the second, nothing else', async () => {
    select.mockResolvedValueOnce('confirm').mockResolvedValueOnce('reject');
    responder = (c) => {
      if (c.method === 'POST' && path(c).endsWith('/confirm')) return { json: { alias: { ...A1, status: 'confirmed' }, already_confirmed: false } };
      if (c.method === 'POST' && path(c).endsWith('/reject')) return { json: { alias: { ...A2, status: 'rejected' } } };
      return serveList([A1, A2])(c);
    };
    await run(['review']);
    expect(exitCode).toBeUndefined();
    expect(calls[0]).toMatchObject({ method: 'GET' });
    expect(path(calls[0]!)).toBe('/glossary/aliases?status=proposed');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer tok_real');
    expect(posts().map((c) => `${c.method} ${path(c)}`)).toEqual([
      `POST /glossary/aliases/${A1.id}/confirm`,
      `POST /glossary/aliases/${A2.id}/reject`,
    ]);
    expect(out.join('\n')).toMatch(/1 confirmed, 1 rejected/);
  });

  it('prompts show what is being confirmed: the alias and the canonical it would resolve to', async () => {
    select.mockResolvedValue('skip');
    await run(['review']);
    const first = select.mock.calls[0]![0] as { message: string };
    expect(first.message).toContain('payments-svc');
    expect(first.message).toContain('payments');
  });

  it('5. an id is encoded into the path, so a hostile id cannot leave /glossary/aliases/', async () => {
    const hostile = { ...A1, id: '../auth/me' };
    select.mockResolvedValueOnce('confirm');
    responder = (c) => (c.method === 'POST' ? { json: { alias: hostile, already_confirmed: false } } : serveList([hostile])(c));
    await run(['review']);
    expect(path(posts()[0]!)).toBe('/glossary/aliases/..%2Fauth%2Fme/confirm');
  });

  it('6. 403 confirmation_requires_human: says the gateway wants a signed-in web session, stops, confirms nothing more', async () => {
    select.mockResolvedValue('confirm');
    responder = (c) => (c.method === 'POST' ? { status: 403, json: { error: 'confirmation_requires_human' } } : serveList([A1, A2])(c));
    await run(['review']);
    expect(exitCode).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(err.join('\n')).toMatch(/signed-in|web app|browser/i);
    expect(err.join('\n')).toContain('confirmation_requires_human');
  });

  it('7. 409 alias_would_not_apply: reports that alias and moves on to the next one', async () => {
    select.mockResolvedValue('confirm');
    responder = (c) => {
      if (c.method === 'POST' && path(c).includes(A1.id)) return { status: 409, json: { error: 'alias_would_not_apply' } };
      if (c.method === 'POST') return { json: { alias: { ...A2, status: 'confirmed' }, already_confirmed: false } };
      return serveList([A1, A2])(c);
    };
    await run(['review']);
    expect(exitCode).toBeUndefined();
    expect(posts()).toHaveLength(2);
    expect(out.join('\n')).toMatch(/payments-svc/);
    expect(out.join('\n')).toMatch(/would not apply|could not be confirmed/i);
    expect(out.join('\n')).toMatch(/1 confirmed/);
  });

  it('8. --bootstrap proposes from the gateway first, then lists, and the bootstrap confirms nothing itself', async () => {
    select.mockResolvedValue('skip');
    responder = (c) =>
      c.method === 'POST' && path(c) === '/glossary/bootstrap'
        ? { json: { candidates: 5, proposed: 2, alreadyKnown: 3, overProposalCap: 0, signalRowsOmitted: { scopes: 0, teams: 0, repoMappings: 0 } } }
        : serveList([A1, A2])(c);
    await run(['review', '--bootstrap']);
    expect(calls.map((c) => `${c.method} ${path(c)}`)).toEqual([
      'POST /glossary/bootstrap',
      'GET /glossary/aliases?status=proposed',
    ]);
    expect(out.join('\n')).toMatch(/2 new/);
  });

  it('10. a partial list (omitted > 0) says how many were left out and to run it again', async () => {
    select.mockResolvedValue('skip');
    responder = serveList([A1], 7);
    await run(['review']);
    expect(out.join('\n')).toMatch(/7 more/);
  });

  it('11. nothing proposed: says so and exits 0 without prompting', async () => {
    responder = serveList([]);
    await run(['review']);
    expect(exitCode).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/nothing to review/i);
  });

  it('12. local mode: refuses with the cloud-only message and sends nothing', async () => {
    getEnvironment.mockReturnValue({ mode: 'local-embedded', localDbPath: ':memory:' });
    await run(['review']);
    expect(exitCode).toBe(1);
    expect(err.join('\n') + out.join('\n')).toMatch(/not available in local mode/);
    expect(calls).toHaveLength(0);
  });
});

describe('align glossary review --list', () => {
  it('9. prints the proposed aliases without a terminal and never posts', async () => {
    setStdinTty(false);
    await run(['review', '--list']);
    expect(exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(posts()).toHaveLength(0);
    expect(select).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('payments-svc');
    expect(out.join('\n')).toContain('Falcon');
  });
});
