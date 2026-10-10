import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_TOKEN, GW, installFakeGateway, linkFor, makeHarness, NEW_TOKEN, okMe, okPeek, PROD_TOKEN, TOKEN } from './helpers/join-harness.js';
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

    const h = makeHarness({ typed: TYPED });
    const r2 = await runJoin(h.deps, { link: linkFor({ gw: null }), gateway: GW });
    expect(r2.ok).toBe(true);
  });
});

describe('runJoin: the peek has to agree with the link (S2)', () => {
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

  it('a peek naming the same gateway with a trailing slash is accepted; a peek with no gateway_url is accepted', async () => {
    installFakeGateway({ peek: okPeek({ gateway_url: `${GW}/` }) });
    const a = makeHarness({ typed: TYPED });
    expect((await runJoin(a.deps, { link: linkFor() })).ok).toBe(true);

    installFakeGateway({ peek: { status: 200, body: { org_name: 'Acme Platform', has_email_restriction: false, app_url: 'https://align.acme.example' } } });
    const b = makeHarness({ typed: TYPED });
    expect((await runJoin(b.deps, { link: linkFor() })).ok).toBe(true);
  });

  it('an app host that differs from the peek is refused, and no browser opens', async () => {
    installFakeGateway({ peek: okPeek({ app_url: 'https://align.evil.example' }) });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    expectUntouched(h);
  });

  it('a peek with no app_url is refused: the browser URL must come from the gateway', async () => {
    installFakeGateway({ peek: { status: 200, body: { org_name: 'Acme', has_email_restriction: false } } });
    const h = makeHarness({ typed: TYPED });
    expect((await runJoin(h.deps, { link: linkFor() })).ok).toBe(false);
    expectUntouched(h);
  });

  it('opens the PEEK\'s app URL, not the link\'s (same host, different scheme as a sentinel)', async () => {
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
});

describe('runJoin: the host is confirmed by a person (S1)', () => {
  it('Align hosts need no type-back', async () => {
    installFakeGateway({ peek: okPeek({ gateway_url: 'https://api.align.tech', app_url: 'https://app.align.tech' }) });
    const h = makeHarness({ typed: null });
    const r = await runJoin(h.deps, { link: linkFor({ app: 'https://app.align.tech', gw: 'https://api.align.tech' }), name: 'hosted' });
    expect(r.ok).toBe(true);
    expect(h.prompts).toEqual([]);
  });

  it('a lookalike under align.tech.evil.example needs the host typed', async () => {
    const gw = 'https://api.align.tech.evil.example';
    installFakeGateway({ peek: okPeek({ gateway_url: gw, app_url: 'https://app.align.tech' }) });
    const h = makeHarness({ typed: 'api.align.tech.evil.example' });
    const r = await runJoin(h.deps, { link: linkFor({ app: 'https://app.align.tech', gw }) });
    expect(r.ok).toBe(true);
    expect(h.prompts).toHaveLength(1);
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

  it('a non-TTY run outside align.tech refuses without --confirm-host, and proceeds with the matching one', async () => {
    installFakeGateway();
    const refused = makeHarness({ tty: false });
    const r1 = await runJoin(refused.deps, { link: linkFor() });
    expect(r1.ok).toBe(false);
    expect(refused.out.join('\n')).toContain('--confirm-host');
    expect(refused.prompts).toEqual([]);
    expectUntouched(refused);

    const wrong = makeHarness({ tty: false });
    expect((await runJoin(wrong.deps, { link: linkFor(), confirmHost: 'api.other.example' })).ok).toBe(false);
    expectUntouched(wrong);

    const ok = makeHarness({ tty: false });
    expect((await runJoin(ok.deps, { link: linkFor(), confirmHost: 'api.acme.example' })).ok).toBe(true);
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

describe('runJoin: server-chosen text (S8)', () => {
  it('control characters and escape sequences in the org name are shown escaped and labelled as a claim', async () => {
    const esc = String.fromCharCode(27);
    installFakeGateway({ peek: okPeek({ org_name: `Acme${esc}[2J\r Platform` }) });
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor(), name: 'acme' });
    const text = h.out.join('\n');
    expect(text.includes(esc)).toBe(false);
    expect(text.includes('\r')).toBe(false);
    expect(text).toContain('\\x1b');
    expect(text).toMatch(/as claimed by api\.acme\.example/);
  });
});

describe('runJoin: the token is verified before anything is saved', () => {
  it('a whoami 401 with the new token saves nothing', async () => {
    installFakeGateway({ me: { status: 401, body: { error: 'nope' } } });
    const h = makeHarness({ typed: TYPED });
    const r = await runJoin(h.deps, { link: linkFor() });
    expect(r.ok).toBe(false);
    expect(h.opened).toHaveLength(1);
    expect(h.config.listTeamDestinationNames()).toEqual([]);
    expect(h.config.getShareDestination()).toBeNull();
  });

  it('an unreachable gateway at whoami saves nothing either (unlike login, which saves on unreachable)', async () => {
    installFakeGateway({ me: 'unreachable' });
    const h = makeHarness({ typed: TYPED });
    expect((await runJoin(h.deps, { link: linkFor() })).ok).toBe(false);
    expect(h.config.listTeamDestinationNames()).toEqual([]);
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
    expect(h.out.join('\n')).not.toMatch(/differs|does not match/i);
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

describe('runJoin: what is saved', () => {
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

  it('the first join sets the share destination', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED });
    await runJoin(h.deps, { link: linkFor(), name: 'acme' });
    expect(h.config.getShareDestination()).toBe('acme');
    expect(h.confirms).toEqual([]);
  });

  it('a second join asks before changing the share destination: no keeps acme, yes moves to beta', async () => {
    installFakeGateway();
    const h = makeHarness({ typed: TYPED, confirm: false });
    await runJoin(h.deps, { link: linkFor(), name: 'acme' });
    const r = await runJoin(h.deps, { link: linkFor(), name: 'beta' });
    expect(r).toMatchObject({ ok: true, name: 'beta' });
    expect(h.confirms).toHaveLength(1);
    expect(h.config.hasTeamDestination('beta')).toBe(true);
    expect(h.config.getShareDestination()).toBe('acme');

    const yes = makeHarness({ typed: TYPED, confirm: true });
    await runJoin(yes.deps, { link: linkFor(), name: 'acme' });
    await runJoin(yes.deps, { link: linkFor(), name: 'beta' });
    expect(yes.config.getShareDestination()).toBe('beta');
  });

  it('non-interactively the share destination stays put unless --make-share-destination is given', async () => {
    installFakeGateway();
    const h = makeHarness({ tty: false });
    await runJoin(h.deps, { link: linkFor(), name: 'acme', confirmHost: TYPED });
    await runJoin(h.deps, { link: linkFor(), name: 'beta', confirmHost: TYPED });
    expect(h.config.getShareDestination()).toBe('acme');
    expect(h.confirms).toEqual([]);
    await runJoin(h.deps, { link: linkFor(), name: 'gamma', confirmHost: TYPED, makeShareDestination: true });
    expect(h.config.getShareDestination()).toBe('gamma');
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

describe('runJoin: the destination name', () => {
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
    expect((await runJoin(h.deps, { link: linkFor(), name: 'acme', replace: true })).ok).toBe(true);
  });
});
