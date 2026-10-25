import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_TOKEN, GW, installFakeGateway, linkFor, makeHarness, meBody, NEW_TOKEN, okMe, okPeek, PROD_TOKEN, TOKEN } from './helpers/join-harness.js';
import { runJoin } from '../lib/join-flow.js';

vi.mock('conf', () => {
  let store: Record<string, unknown> = {};
  return {
    default: class {
      private defaults: Record<string, unknown>;
      constructor(opts: { defaults?: Record<string, unknown> }) {
        this.defaults = opts.defaults ?? {};
        store = { ...this.defaults };
      }
      get(k: string) { return store[k]; }
      set(k: string, v: unknown) { store[k] = v; }
      has(k: string) { return k in store; }
      delete(k: string) { delete store[k]; }
      clear() { store = { ...this.defaults }; }
    },
  };
});

const TYPED = 'api.acme.example';
const NOTE = 'chosen by that organisation, not verified by Align';

beforeEach(() => {
  vi.stubEnv('ALIGN_TOKEN', '');
  vi.stubEnv('ALIGN_TENANT_ID', '');
  vi.stubEnv('ALIGN_GATEWAY_URL', '');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** Nothing was saved and no browser was opened: read the store, never the exit code. */
function expectUntouched(h: ReturnType<typeof makeHarness>) {
  expect(h.config.listTeamDestinationNames()).toEqual([]);
  expect(h.config.getShareDestination()).toBeNull();
  expect(h.opened).toEqual([]);
  expect(h.waits).toBe(0);
}

describe('runJoin: only a person at a terminal, never an agent (join review F1)', () => {
  it('refuses when stdin or stdout is not a terminal, for ANY host, before a single request', async () => {
    for (const gw of [GW, 'https://api.align.tech']) {
      const seen = installFakeGateway();
      const h = makeHarness({ tty: false });
      const r = await runJoin(h.deps, { link: linkFor({ gw, app: gw === GW ? undefined : 'https://app.align.tech' }) });
      expect(r.ok).toBe(false);
      expect(seen).toEqual([]);
      expectUntouched(h);
    }
  });

  it('the refusal does not hand over a flag to bypass it, and does not print the host', async () => {
    installFakeGateway();
    const h = makeHarness({ tty: false });
    await runJoin(h.deps, { link: linkFor() });
    const text = h.out.join('\n');
    expect(text).not.toContain('--confirm-host');
    expect(text).not.toContain('api.acme.example');
    expect(text).toMatch(/terminal/);
  });

  it('refuses inside an agent align launched (ALIGN_WRAPPED), even on a terminal, before any request', async () => {
    const seen = installFakeGateway();
    const h = makeHarness({ tty: true, wrapped: true, typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    expect(seen).toEqual([]);
    expect(h.prompts).toEqual([]);
    expectUntouched(h);
  });

  it('on a terminal and not wrapped it goes on (the control for the two refusals above)', async () => {
    installFakeGateway();
    const h = makeHarness({ tty: true, wrapped: false, typed: TYPED });
    expect((await runJoin(h.deps, { link: linkFor() })).ok).toBe(true);
  });

  // Joining saves a login and wires nothing, so the agent cannot read the team graph yet.
  // The last thing printed is the one command that connects it, runnable as printed.
  it('ends by naming the command that connects the agent to the joined graph', async () => {
    installFakeGateway();
    const h = makeHarness({ tty: true, wrapped: false, typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(true);
    const last = h.out[h.out.length - 1]!;
    expect(last).toMatch(/^ {2}Connect your agent to it: align mcp --setup --env \S+$/);
  });
});

describe('runJoin: link and transport (S3)', () => {
  it('refuses an http gateway before any request', async () => {
    const seen = installFakeGateway();
    const h = makeHarness();
    const r = await runJoin(h.deps, { link: linkFor({ gw: 'http://api.acme.example' }) });
    expect(r.ok).toBe(false);
    expect(seen).toEqual([]);
    expectUntouched(h);
  });

  it('accepts http://localhost:8080 (the loopback is exempt)', async () => {
    installFakeGateway({ peek: okPeek({ gateway_url: 'http://localhost:8080', app_url: 'http://localhost:5173' }) });
    const h = makeHarness({ typed: 'localhost:8080' });
    const r = await runJoin(h.deps, { link: linkFor({ app: 'http://localhost:5173', gw: 'http://localhost:8080' }) });
    expect(r).toMatchObject({ ok: true, name: 'acme-platform' });
  });

  it('a link with no gw is refused naming --gateway; --gateway makes it work', async () => {
    installFakeGateway();
    const refused = makeHarness();
    const r1 = await runJoin(refused.deps, { link: linkFor({ gw: null }) });
    expect(r1.ok).toBe(false);
    expect(refused.out.join('\n')).toContain('--gateway');
    expectUntouched(refused);

    installFakeGateway({ peek: okPeek({ gateway_url: undefined }) });
    const h = makeHarness({ typed: TYPED });
    const r2 = await runJoin(h.deps, { link: linkFor({ gw: null }), gateway: GW });
    expect(r2.ok).toBe(true);
  });
});

describe('runJoin: the peek has to agree with the link (S2, F3)', () => {
  it('a peek naming another gateway is refused, with both printed', async () => {
    installFakeGateway({ peek: okPeek({ gateway_url: 'https://api.evil.example' }) });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    const text = h.out.join('\n');
    expect(text).toContain('api.evil.example');
    expect(text).toContain('api.acme.example');
    expectUntouched(h);
  });

  it('a peek naming the same gateway with a trailing slash is accepted', async () => {
    installFakeGateway({ peek: okPeek({ gateway_url: `${GW}/` }) });
    const a = makeHarness({ typed: TYPED });
    expect((await runJoin(a.deps, { link: linkFor() })).ok).toBe(true);
  });

  it('a link that carried a gateway and a peek that names none is refused: a real gateway that wrote gw= also reports it', async () => {
    installFakeGateway({ peek: okPeek({ gateway_url: undefined }) });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    expectUntouched(h);
  });

  it('an app host that differs from the peek is refused, and no browser opens', async () => {
    installFakeGateway({ peek: okPeek({ app_url: 'https://align.evil.example' }) });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    expectUntouched(h);
  });

  it('a peek with no app_url is refused: the browser URL must come from the gateway', async () => {
    installFakeGateway({ peek: { status: 200, body: { org_name: 'Acme', has_email_restriction: false, gateway_url: GW } } });
    const h = makeHarness({ typed: TYPED });
    expect((await runJoin(h.deps, { link: linkFor() })).ok).toBe(false);
    expectUntouched(h);
  });

  it('opens the PEEK\'s app URL, not the link\'s (same host, different scheme as a sentinel), and tells the page which gateway to expect', async () => {
    installFakeGateway({ peek: okPeek({ gateway_url: 'http://localhost:8080', app_url: 'https://localhost:5173' }) });
    const h = makeHarness({ typed: 'localhost:8080' });
    const r = await runJoin(h.deps, { link: linkFor({ app: 'http://localhost:5173', gw: 'http://localhost:8080' }) });
    expect(r.ok).toBe(true);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toMatch(/^https:\/\/localhost:5173\/join\?/);
    const u = new URL(h.opened[0] as string);
    expect(u.searchParams.get('token')).toBe(TOKEN);
    expect(u.searchParams.get('cli_port')).toBe('7654');
    expect(u.searchParams.get('cli_nonce')).toBe('nonce-fixed');
    expect(u.searchParams.get('cli_gw')).toBe('http://localhost:8080');
  });

  it('cli_gw is the link\'s gateway origin, URL-encoded, and only after the peek agreed', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor() });
    const opened = h.opened[0] as string;
    expect(opened).toContain(`cli_gw=${encodeURIComponent(GW)}`);

    installFakeGateway({ peek: okPeek({ gateway_url: 'https://api.evil.example' }) });
    const bad = makeHarness({ typed: TYPED });
    await runJoin(bad.deps, { link: linkFor() });
    expect(bad.opened).toEqual([]);
  });

  it('the peek is an unauthenticated request that refuses redirects', async () => {
    const seen = installFakeGateway();
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor() });
    const peek = seen.find((s) => s.url.includes('/auth/invite-peek'));
    expect(peek?.authorization).toBeNull();
    expect(peek?.init?.redirect).toBe('error');
  });

  it('a peek 404 saves nothing and opens nothing', async () => {
    installFakeGateway({ peek: { status: 404, body: { error: 'Invite not found or expired' } } });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    expect(h.out.join('\n')).toMatch(/not found|expired/i);
    expectUntouched(h);
  });

  it('the peek size cap is enforced WHILE streaming: an endless body is cut off near the cap (F7)', async () => {
    let pulled = 0;
    let cancelled = false;
    installFakeGateway({
      peekResponse: () => new Response(new ReadableStream<Uint8Array>({
        pull(c) { pulled += 1; c.enqueue(new Uint8Array(4096).fill(120)); },
        cancel() { cancelled = true; },
      }), { status: 200 }),
    });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    expect(cancelled).toBe(true);
    // 16 KB cap, 4 KB chunks: the stream may be pulled a few times past it for read-ahead, never without bound.
    expect(pulled).toBeLessThan(20);
    expectUntouched(h);
  });

  it('a body just under the cap is read in full (the boundary is on the right side)', async () => {
    const pad = 'x'.repeat(16 * 1024 - 200);
    installFakeGateway({ peek: okPeek({ extra: pad }) });
    const h = makeHarness({ typed: TYPED });
    expect((await runJoin(h.deps, { link: linkFor() })).ok).toBe(true);
  });
});

describe('runJoin: a person confirms the host (S1, F1)', () => {
  it('an Align host needs no typed host, but the org name is shown as the organisation\'s own and a typed y is needed', async () => {
    installFakeGateway({ peek: okPeek({ gateway_url: 'https://api.align.tech', app_url: 'https://app.align.tech' }) });
    const h = makeHarness({ answers: ['y'] });
    const r = await runJoin(h.deps, { link: linkFor({ app: 'https://app.align.tech', gw: 'https://api.align.tech' }), name: 'hosted' });
    expect(r.ok).toBe(true);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toMatch(/Acme Platform/);
    expect(h.out.join('\n')).toContain(NOTE);
  });

  it('an Align host: anything but y stops, and nothing is saved or opened', async () => {
    for (const answer of ['n', '', null, 'maybe']) {
      installFakeGateway({ peek: okPeek({ gateway_url: 'https://api.align.tech', app_url: 'https://app.align.tech' }) });
      const h = makeHarness({ answers: [answer] });
      const r = await runJoin(h.deps, { link: linkFor({ app: 'https://app.align.tech', gw: 'https://api.align.tech' }), name: 'hosted' });
      expect(r.ok).toBe(false);
      expectUntouched(h);
    }
  });

  it('a lookalike under align.tech.evil.example needs the host typed', async () => {
    const gw = 'https://api.align.tech.evil.example';
    installFakeGateway({ peek: okPeek({ gateway_url: gw, app_url: 'https://app.align.tech' }) });
    const h = makeHarness({ typed: 'api.align.tech.evil.example' });
    const r = await runJoin(h.deps, { link: linkFor({ app: 'https://app.align.tech', gw }) });
    expect(r.ok).toBe(true);
    expect(h.prompts[0]).toMatch(/Type the gateway host/);
  });

  it('a wrong typed host saves nothing and opens nothing; the right one proceeds', async () => {
    installFakeGateway();
    const wrong = makeHarness({ typed: 'api.acme.exampl' });
    expect((await runJoin(wrong.deps, { link: linkFor() })).ok).toBe(false);
    expectUntouched(wrong);

    const cancelled = makeHarness({ typed: null });
    expect((await runJoin(cancelled.deps, { link: linkFor() })).ok).toBe(false);
    expectUntouched(cancelled);

    const right = makeHarness({ typed: '  API.acme.example ' });
    expect((await runJoin(right.deps, { link: linkFor() })).ok).toBe(true);
  });

  it('prints both hosts before the browser opens, and a punycode host decoded and raw with a warning', async () => {
    const raw = 'xn--pple-43d.example';
    installFakeGateway({ peek: okPeek({ gateway_url: `https://${raw}`, app_url: 'https://align.acme.example' }) });
    const h = makeHarness({ typed: raw });
    const order: string[] = [];
    h.deps.openUrl = async () => { order.push(h.out.join('\n')); return true; };
    await runJoin(h.deps, { link: linkFor({ gw: `https://${raw}` }) });
    const text = h.out.join('\n');
    expect(text).toContain(raw);
    expect(text).toContain('аpple.example');
    expect(text).toMatch(/non-ASCII/);
    expect(order[0]).toContain('align.acme.example');
    expect(order[0]).toContain(raw);
  });

  it('an ASCII host is printed once per line, with no warning', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor() });
    expect(h.out.join('\n')).not.toMatch(/non-ASCII/);
    expect(h.out.filter((l) => l.includes('Gateway:'))).toHaveLength(1);
  });
});

describe('runJoin: server-chosen text (S8, F6)', () => {
  it('control characters and escape sequences in the org name are shown escaped, with a label that does not vouch for it', async () => {
    const esc = String.fromCharCode(27);
    installFakeGateway({ peek: okPeek({ org_name: `Acme${esc}[2J\r Platform` }) });
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor(), name: 'acme' });
    const text = h.out.join('\n');
    expect(text.includes(esc)).toBe(false);
    expect(text.includes('\r')).toBe(false);
    expect(text).toContain('\\x1b');
    expect(text).toContain(NOTE);
    expect(text).not.toMatch(/claimed by/);
  });
});

describe('runJoin: the token is verified before anything is saved (F5)', () => {
  it('a whoami 401 with the new token saves nothing', async () => {
    installFakeGateway({ me: { status: 401, body: { error: 'nope' } } });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    expect(h.opened).toHaveLength(1);
    expect(h.config.listTeamDestinationNames()).toEqual([]);
    expect(h.config.getShareDestination()).toBeNull();
  });

  it('after the browser step the refusal does not claim no browser was opened, and says the issued token stays valid until it expires (second review N6)', async () => {
    installFakeGateway({ me: { status: 401, body: { error: 'nope' } } });
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor() });
    const text = h.out.join('\n');
    expect(text).not.toContain('no browser was opened');
    expect(text).toMatch(/Nothing was saved/);
    expect(text).toMatch(/stays valid until 2027-01-08/);
  });

  it('a callback that never carries a token: the browser did open, so the text says that and claims no issued token', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED, callback: 'reject' });
    await runJoin(h.deps, { link: linkFor() });
    const text = h.out.join('\n');
    expect(text).not.toContain('no browser was opened');
    expect(text).not.toMatch(/stays valid/);
  });

  it('a refusal BEFORE the browser still says no browser was opened (the control)', async () => {
    installFakeGateway({ peek: { status: 404 } });
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor() });
    expect(h.out.join('\n')).toContain('no browser was opened');
  });

  it('--gateway on a link with no gw= is passed to the page as cli_gw the same way', async () => {
    installFakeGateway({ peek: okPeek({ gateway_url: undefined }) });
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor({ gw: null }), gateway: GW });
    expect(h.opened[0]).toContain(`cli_gw=${encodeURIComponent(GW)}`);
  });

  it('an unreachable gateway at whoami saves nothing either (unlike login, which saves on unreachable)', async () => {
    installFakeGateway({ me: 'unreachable' });
    const h = makeHarness({ typed: TYPED });
    expect((await runJoin(h.deps, { link: linkFor() })).ok).toBe(false);
    expect(h.config.listTeamDestinationNames()).toEqual([]);
  });

  it.each([
    ['an empty object', {}],
    ['a string', 'hello'],
    ['null', null],
    ['a user with no email', { user: {}, tenant: { id: 't', name: 'x' } }],
    ['an email that is not a string', { user: { email: 7 }, tenant: { id: 't', name: 'x' } }],
    ['no tenant', { user: { email: 'a@b.example' } }],
    ['a tenant id that is an object', { user: { email: 'a@b.example' }, tenant: { id: { x: 1 }, name: 'x' } }],
    ['an empty tenant id', { user: { email: 'a@b.example' }, tenant: { id: '', name: 'x' } }],
    ['a tenant id with control characters', { user: { email: 'a@b.example' }, tenant: { id: 't\u001b[2J', name: 'x' } }],
    ['a tenant name that is not a string', { user: { email: 'a@b.example' }, tenant: { id: 't', name: 7 } }],
  ])('a malformed whoami (%s) saves nothing, crashes nothing, and says so', async (_n, body) => {
    installFakeGateway({ me: meBody(body) });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    expect(h.config.listTeamDestinationNames()).toEqual([]);
    expect(h.config.getShareDestination()).toBeNull();
  });

  it('an email and a tenant name with escape sequences are printed escaped', async () => {
    const esc = String.fromCharCode(27);
    installFakeGateway({ me: meBody({ user: { email: `dev@acme.example${esc}]0;pwned`, role: 'member' }, tenant: { id: 'tenant-acme', name: `Acme${esc}[2J` } }) });
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor() });
    const text = h.out.join('\n');
    expect(text.includes(esc)).toBe(false);
  });

  it('a callback that carries no token, or never arrives, saves nothing', async () => {
    installFakeGateway();
    const none = makeHarness({ typed: TYPED, callback: {} });
    expect((await runJoin(none.deps, { link: linkFor() })).ok).toBe(false);
    expect(none.config.listTeamDestinationNames()).toEqual([]);
    const timeout = makeHarness({ typed: TYPED, callback: 'reject' });
    expect((await runJoin(timeout.deps, { link: linkFor() })).ok).toBe(false);
    expect(timeout.config.listTeamDestinationNames()).toEqual([]);
  });

  it('a tenant name that differs from the peek\'s org name is saved with a warning naming both', async () => {
    installFakeGateway({ me: okMe({ tenantName: 'Totally Other Org' }) });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(true);
    const text = h.out.join('\n');
    expect(text).toContain('Totally Other Org');
    expect(text).toContain('Acme Platform');
    expect(h.config.hasTeamDestination('acme-platform')).toBe(true);
  });

  it('a matching tenant name prints no mismatch warning', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor() });
    expect(h.out.join('\n')).not.toMatch(/differs|does not match|Heads up/i);
  });

  it('the gateway only ever sees the NEW token: never ALIGN_TOKEN, never a stored prod token (S4)', async () => {
    const seen = installFakeGateway();
    vi.stubEnv('ALIGN_TOKEN', ENV_TOKEN);
    const h = makeHarness({ typed: TYPED });
    h.config.setAuthToken('prod', PROD_TOKEN);
    await runJoin(h.deps, { link: linkFor() });
    const auths = seen.map((s) => s.authorization).filter((a): a is string => a !== null);
    expect(auths).toEqual([`Bearer ${NEW_TOKEN}`]);
    expect(seen.every((s) => s.url.startsWith(GW))).toBe(true);
    expect(JSON.stringify(h.out)).not.toContain(NEW_TOKEN);
  });
});

describe('runJoin: what is saved, and the share destination only on a yes (F1)', () => {
  it('stores the destination whole, from the peek and whoami, and tells the expiry date', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r).toMatchObject({ ok: true, name: 'acme-platform', expiresAt: '2027-01-08T00:00:00.000Z' });
    expect(h.config.getEnvironment('acme-platform')).toMatchObject({
      gatewayUrl: GW, appUrl: 'https://align.acme.example', authToken: NEW_TOKEN, tenantId: 'tenant-acme', orgNameClaimed: 'Acme Platform',
    });
    expect(h.out.join('\n')).toContain('2027-01-08');
    expect(h.out.join('\n')).toContain('align login --env acme-platform');
  });

  it('an invalid or missing expires_at is not printed as a date', async () => {
    installFakeGateway();
    const bad = makeHarness({ typed: TYPED, callback: { token: NEW_TOKEN, expires_at: 'garbage' } });
    const r = await runJoin(bad.deps, { link: linkFor() });
    expect(r).toMatchObject({ ok: true });
    expect((r as { expiresAt?: string }).expiresAt).toBeUndefined();
    expect(bad.out.join('\n')).not.toMatch(/expires/i);
  });

  it('the FIRST join asks before setting the share destination: yes sets it and says so plainly; no leaves it unset', async () => {
    installFakeGateway();
    const yes = makeHarness({ typed: TYPED, confirm: true });
    await runJoin(yes.deps, { link: linkFor(), name: 'acme' });
    expect(yes.confirms).toHaveLength(1);
    expect(yes.confirms[0]).toMatch(/Acme Platform/);
    expect(yes.config.getShareDestination()).toBe('acme');
    expect(yes.out.join('\n')).toContain('Shares from this machine now go to "Acme Platform" at api.acme.example');

    const no = makeHarness({ typed: TYPED, confirm: false });
    await runJoin(no.deps, { link: linkFor(), name: 'acme' });
    expect(no.confirms).toHaveLength(1);
    expect(no.config.hasTeamDestination('acme')).toBe(true);
    expect(no.config.getShareDestination()).toBeNull();
    expect(no.out.join('\n')).not.toContain('Shares from this machine now go to');
  });

  it('a second join to another name asks again: no keeps acme, yes moves to beta', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED, confirms: [true, false] });
    await runJoin(h.deps, { link: linkFor(), name: 'acme' });
    const r = await runJoin(h.deps, { link: linkFor(), name: 'beta' });
    expect(r).toMatchObject({ ok: true, name: 'beta' });
    expect(h.confirms).toHaveLength(2);
    expect(h.config.getShareDestination()).toBe('acme');

    const yes = makeHarness({ typed: TYPED, confirms: [true, true] });
    await runJoin(yes.deps, { link: linkFor(), name: 'acme' });
    await runJoin(yes.deps, { link: linkFor(), name: 'beta' });
    expect(yes.config.getShareDestination()).toBe('beta');
  });

  it('the join never touches the prod token or the default environment', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED });
    h.config.setAuthToken('prod', PROD_TOKEN);
    await runJoin(h.deps, { link: linkFor() });
    expect(h.config.getEnvironment('prod').authToken).toBe(PROD_TOKEN);
    expect(h.config.getDefaultEnv()).toBe('prod');
  });
});

describe('runJoin: the destination name and --replace (F2)', () => {
  it('derives it from the claimed org name; --name wins', async () => {
    installFakeGateway();
    const a = makeHarness({ typed: TYPED });
    expect(await runJoin(a.deps, { link: linkFor() })).toMatchObject({ name: 'acme-platform' });
    const b = makeHarness({ typed: TYPED });
    expect(await runJoin(b.deps, { link: linkFor(), name: 'work' })).toMatchObject({ name: 'work' });
  });

  it('refuses a reserved or invalid --name before opening a browser', async () => {
    installFakeGateway();
    for (const name of ['prod', 'a:b', 'Acme']) {
      const h = makeHarness({ typed: TYPED });
      expect((await runJoin(h.deps, { link: linkFor(), name })).ok).toBe(false);
      expectUntouched(h);
    }
  });

  it('an org name with nothing usable in it needs --name', async () => {
    installFakeGateway({ peek: okPeek({ org_name: '日本語' }) });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    expect(h.out.join('\n')).toContain('--name');
    expectUntouched(h);
  });

  it('never overwrites an existing name without --replace', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor(), name: 'acme' });
    const before = h.config.getEnvironment('acme').authToken;
    h.opened.length = 0;
    const r = await runJoin(h.deps, { link: linkFor(), name: 'acme' });
    expect(r.ok).toBe(false);
    expect(h.out.join('\n')).toContain('--replace');
    expect(h.opened).toEqual([]);
    expect(h.config.getEnvironment('acme').authToken).toBe(before);
  });

  const OLD_GW = 'https://api.old.example';
  const seedOld = (h: ReturnType<typeof makeHarness>, shareToo: boolean) => {
    h.config.saveTeamDestination('acme', { gatewayUrl: OLD_GW, appUrl: 'https://align.old.example', authToken: ['al', 'old', 'tok'].join('_'), tenantId: 'T-old', orgNameClaimed: 'Old' });
    if (shareToo) h.config.setShareDestination('acme');
  };

  it('--replace shows the old and the new host, needs the NEW host typed (even for an Align host), and only then replaces', async () => {
    installFakeGateway({ peek: okPeek({ gateway_url: 'https://api.align.tech', app_url: 'https://app.align.tech' }) });
    const h = makeHarness({ answers: ['y', 'api.align.tech'] });
    seedOld(h, false);
    const r = await runJoin(h.deps, { link: linkFor({ app: 'https://app.align.tech', gw: 'https://api.align.tech' }), name: 'acme', replace: true });
    expect(r.ok).toBe(true);
    const text = h.out.join('\n');
    expect(text).toContain('api.old.example');
    expect(text).toContain('api.align.tech');
    expect(h.prompts.some((q) => /Type the (new )?gateway host/.test(q))).toBe(true);
    expect(h.config.getEnvironment('acme').gatewayUrl).toBe('https://api.align.tech');
  });

  it('--replace with the wrong host typed changes nothing; a non-terminal --replace is refused outright', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: 'api.acme.exampl' });
    seedOld(h, false);
    expect((await runJoin(h.deps, { link: linkFor(), name: 'acme', replace: true })).ok).toBe(false);
    expect(h.config.getEnvironment('acme').gatewayUrl).toBe(OLD_GW);
    expect(h.opened).toEqual([]);

    const nt = makeHarness({ tty: false });
    seedOld(nt, false);
    expect((await runJoin(nt.deps, { link: linkFor(), name: 'acme', replace: true })).ok).toBe(false);
    expect(nt.config.getEnvironment('acme').gatewayUrl).toBe(OLD_GW);
  });

  it('replacing the share destination asks again, naming the new host: no changes nothing at all', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED, confirms: [false] });
    seedOld(h, true);
    const r = await runJoin(h.deps, { link: linkFor(), name: 'acme', replace: true });
    expect(r.ok).toBe(false);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toContain('api.acme.example');
    expect(h.config.getEnvironment('acme').gatewayUrl).toBe(OLD_GW);
    expect(h.config.getShareDestination()).toBe('acme');
    expect(h.opened).toEqual([]);
  });

  it('replacing the share destination with a yes repoints it and says so; replacing a destination that is NOT the share destination does not ask', async () => {
    installFakeGateway();
    const yes = makeHarness({ typed: TYPED, confirms: [true] });
    seedOld(yes, true);
    const r = await runJoin(yes.deps, { link: linkFor(), name: 'acme', replace: true });
    expect(r.ok).toBe(true);
    expect(yes.config.getEnvironment('acme').gatewayUrl).toBe(GW);
    expect(yes.config.getShareDestination()).toBe('acme');
    expect(yes.out.join('\n')).toContain('Shares from this machine now go to');

    const other = makeHarness({ typed: TYPED });
    seedOld(other, false);
    other.config.saveTeamDestination('beta', { gatewayUrl: 'https://api.beta.example', appUrl: 'https://align.beta.example', authToken: ['al', 'beta'].join('_'), tenantId: 'T-b' });
    other.config.setShareDestination('beta');
    await runJoin(other.deps, { link: linkFor(), name: 'acme', replace: true });
    // The only question is the ordinary one about where shares go from now on; nothing asks to move a share destination that is not being replaced.
    expect(other.confirms).toHaveLength(1);
    expect(other.confirms[0]).toContain('from now on');
    expect(other.confirms[0]).not.toContain('is where');
    expect(other.config.getShareDestination()).toBe('beta');
  });
});
