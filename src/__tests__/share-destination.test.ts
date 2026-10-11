import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore } from '../lib/config.js';
import { resolveAppUrl } from '../lib/env-resolver.js';
import { resolveApprovalAppUrl, resolveShareEnv, ShareTargetError } from '../lib/share/target.js';
import { UnknownEnvError } from '../lib/resolve-env.js';
import { renderPreview } from '../lib/share/preview.js';

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

const ACME = {
  gatewayUrl: 'https://api.acme.example', appUrl: 'https://align.acme.example',
  authToken: ['al', 'acme', 'tok'].join('_'), tenantId: 'T-acme', orgNameClaimed: 'Acme',
};
const PROD_TOKEN = ['al', 'prod', 'tok'].join('_');

beforeEach(() => {
  vi.stubEnv('ALIGN_ENV', '');
  vi.stubEnv('ALIGN_TOKEN', '');
  vi.stubEnv('ALIGN_TENANT_ID', '');
  vi.stubEnv('ALIGN_GATEWAY_URL', '');
});
afterEach(() => vi.unstubAllEnvs());

function withAcme(opts: { shareTo?: boolean } = {}) {
  const c = createConfigStore();
  c.setAuthToken('prod', PROD_TOKEN);
  c.saveTeamDestination('acme', ACME);
  c.saveTeamDestination('beta', { ...ACME, gatewayUrl: 'https://api.beta.example', appUrl: 'https://align.beta.example' });
  if (opts.shareTo !== false) c.setShareDestination('acme');
  return c;
}

describe('resolveShareEnv: a share goes to one destination, and the share destination wins (C4)', () => {
  it('with a share destination and no flags, goes there, even with a prod token saved and prod as the default', () => {
    const c = withAcme();
    expect(resolveShareEnv({}, c)).toBe('acme');
    const e = c.getEnvironment(resolveShareEnv({}, c));
    expect(e.gatewayUrl).toBe('https://api.acme.example');
    expect(e.authToken).toBe(ACME.authToken);
    expect(e.authToken).not.toBe(PROD_TOKEN);
  });

  it('an exported ALIGN_ENV does not move it away from the share destination', () => {
    const c = withAcme();
    vi.stubEnv('ALIGN_ENV', 'preview');
    expect(resolveShareEnv({}, c)).toBe('acme');
  });

  it('with no share destination it is the existing logic: the default env, or --env', () => {
    const c = withAcme({ shareTo: false });
    expect(resolveShareEnv({}, c)).toBe('prod');
    expect(resolveShareEnv({ env: 'preview' }, c)).toBe('preview');
    vi.stubEnv('ALIGN_ENV', 'preview');
    expect(resolveShareEnv({}, c)).toBe('preview');
  });

  it('--env prod while the share destination is acme is refused, naming --to prod', () => {
    const c = withAcme();
    expect(() => resolveShareEnv({ env: 'prod' }, c)).toThrow(ShareTargetError);
    expect(() => resolveShareEnv({ env: 'prod' }, c)).toThrow(/--to prod/);
  });

  it('--env naming the share destination itself is fine; --env naming another team destination is refused', () => {
    const c = withAcme();
    expect(resolveShareEnv({ env: 'acme' }, c)).toBe('acme');
    expect(() => resolveShareEnv({ env: 'beta' }, c)).toThrow(/--to beta/);
  });

  it('--to overrides the share destination, for a builtin and for another team destination', () => {
    const c = withAcme();
    expect(resolveShareEnv({ to: 'prod' }, c)).toBe('prod');
    expect(resolveShareEnv({ to: 'beta' }, c)).toBe('beta');
    expect(resolveShareEnv({ to: 'acme' }, c)).toBe('acme');
  });

  it('--to and --env naming different destinations is refused; naming the same one is fine', () => {
    const c = withAcme();
    expect(() => resolveShareEnv({ to: 'prod', env: 'preview' }, c)).toThrow(/one destination/);
    expect(resolveShareEnv({ to: 'prod', env: 'prod' }, c)).toBe('prod');
  });

  it('an unknown name for either flag fails closed; local is not a place to share to', () => {
    const c = withAcme();
    expect(() => resolveShareEnv({ to: 'acm' }, c)).toThrow(UnknownEnvError);
    expect(() => resolveShareEnv({ env: 'acm' }, c)).toThrow(UnknownEnvError);
    expect(() => resolveShareEnv({ to: 'local' }, c)).toThrow(ShareTargetError);
    expect(() => resolveShareEnv({ env: 'local' }, withAcme({ shareTo: false }))).toThrow(ShareTargetError);
  });
});

describe('naming a team destination that is not the share destination needs a person (second review N4)', () => {
  const person = { wrapped: false, tty: true };

  it('under ALIGN_WRAPPED, or with no terminal, --to <team> is refused unless it is the share destination', () => {
    const c = withAcme();
    for (const ctx of [{ wrapped: true, tty: true }, { wrapped: false, tty: false }, { wrapped: true, tty: false }]) {
      expect(() => resolveShareEnv({ to: 'beta' }, c, ctx)).toThrow(ShareTargetError);
      expect(() => resolveShareEnv({ to: 'beta' }, c, ctx)).toThrow(/terminal/);
      expect(() => resolveShareEnv({ env: 'beta', to: 'beta' }, c, ctx)).toThrow(ShareTargetError);
      expect(resolveShareEnv({ to: 'acme' }, c, ctx)).toBe('acme');
      expect(resolveShareEnv({}, c, ctx)).toBe('acme');
    }
  });

  it('the same --to is fine for a person at a terminal, and a builtin is not caught by this rule', () => {
    const c = withAcme();
    expect(resolveShareEnv({ to: 'beta' }, c, person)).toBe('beta');
    expect(resolveShareEnv({ to: 'prod' }, c, { wrapped: true, tty: false })).toBe('prod');
  });

  it('a destination the person declined to make the share destination is not reachable by an agent: --to and --env both refuse', () => {
    const c = withAcme({ shareTo: false });
    expect(() => resolveShareEnv({ to: 'acme' }, c, { wrapped: true, tty: true })).toThrow(/terminal/);
    expect(() => resolveShareEnv({ env: 'acme' }, c, { wrapped: true, tty: true })).toThrow(/terminal/);
    expect(resolveShareEnv({ to: 'acme' }, c, person)).toBe('acme');
  });
});

describe('resolveApprovalAppUrl: where the approval link points (S15)', () => {
  const guess = 'https://app.align.tech';

  it('a team destination uses its stored web app, and a config that agrees changes nothing', () => {
    expect(resolveApprovalAppUrl({ stored: 'https://align.acme.example', cfgAppUrl: null, guessed: guess }))
      .toEqual({ ok: true, appUrl: 'https://align.acme.example' });
    expect(resolveApprovalAppUrl({ stored: 'https://align.acme.example', cfgAppUrl: 'https://align.acme.example/', guessed: guess }))
      .toEqual({ ok: true, appUrl: 'https://align.acme.example' });
  });

  it('a team destination whose gateway now names ANOTHER web app stops, naming both', () => {
    const r = resolveApprovalAppUrl({ stored: 'https://align.acme.example', cfgAppUrl: 'https://align.evil.example', guessed: guess });
    expect(r.ok).toBe(false);
    const msg = (r as { message: string }).message;
    expect(msg).toContain('align.acme.example');
    expect(msg).toContain('align.evil.example');
  });

  it('a builtin uses the gateway\'s app_url when it gives one, and the old guess only when it does not', () => {
    expect(resolveApprovalAppUrl({ stored: null, cfgAppUrl: 'https://app.selfhost.example', guessed: guess }))
      .toEqual({ ok: true, appUrl: 'https://app.selfhost.example' });
    expect(resolveApprovalAppUrl({ stored: null, cfgAppUrl: null, guessed: guess }))
      .toEqual({ ok: true, appUrl: guess });
  });

  it('an app_url that is not acceptable (plain http to a remote host) is refused, never swapped for the guess', () => {
    const r = resolveApprovalAppUrl({ stored: null, cfgAppUrl: 'http://app.selfhost.example', guessed: guess });
    expect(r.ok).toBe(false);
    const t = resolveApprovalAppUrl({ stored: 'https://align.acme.example', cfgAppUrl: 'http://align.acme.example', guessed: guess });
    expect(t.ok).toBe(false);
  });
});

describe('resolveAppUrl for the other commands that print an approval link', () => {
  it('a team destination answers with the web app it stored, not a guess from its gateway', () => {
    const c = withAcme();
    expect(resolveAppUrl(c.getEnvironment('acme'))).toBe('https://align.acme.example');
  });
  it('the builtins keep the old rule', () => {
    const c = withAcme();
    expect(resolveAppUrl(c.getEnvironment('prod'))).toBe('https://app.align.tech');
    expect(resolveAppUrl(c.getEnvironment('preview'))).toBe('https://app.preview.align.tech');
  });
});

describe('the preview names the gateway host, always (C4)', () => {
  const payloads = [] as never[];
  const base = { workspace: 'Acme', env: 'prod', email: 'me@co.com' };

  it('a builtin with its default gateway: host named, no "not the default" note', () => {
    const t = renderPreview(payloads, { ...base, gatewayHost: 'api.align.tech' });
    expect(t).toContain('To: "Acme" via api.align.tech, as me@co.com');
    expect(t).not.toContain('not the default');
  });

  it('never words the org name as something Align or the host vouches for (join review F6)', () => {
    const t = renderPreview(payloads, { ...base, gatewayHost: 'api.align.tech' });
    expect(t).not.toMatch(/claimed by|verified by Align\b(?!\))/);
    expect(t).toContain('the organisation chose that name; Align does not verify it');
  });

  it('a team destination: host named, and no wording about a default', () => {
    const t = renderPreview(payloads, { ...base, env: 'acme', gatewayHost: 'api.acme.example' });
    expect(t).toContain('To: "Acme" via api.acme.example, as me@co.com');
    expect(t).not.toContain('not the default');
  });

  it('a builtin pointed elsewhere by an override still says so', () => {
    const t = renderPreview(payloads, { ...base, gatewayHost: 'x.example', gateway: 'https://x.example' });
    expect(t).toContain('via x.example, as me@co.com (the organisation chose that name; Align does not verify it; this gateway is not the default for prod)');
  });

  it('the workspace name the server chose cannot rewrite the line', () => {
    const esc = String.fromCharCode(27);
    const t = renderPreview(payloads, { ...base, workspace: `Acme${esc}[2J`, gatewayHost: 'api.acme.example' });
    const last = t.split('\n').pop() as string;
    expect(last.includes(esc)).toBe(false);
    expect(last).toContain('\\x1b');
  });
});
