/** Test-only: a conf stand-in, a fake gateway behind a stubbed fetch, and the deps `runJoin` takes. */
import { vi } from 'vitest';
import type { CallbackResult } from '../../lib/cli-oauth.js';
import { createConfigStore } from '../../lib/config.js';
import type { JoinDeps } from '../../lib/join-flow.js';

export const TOKEN = 'cd'.repeat(32);
/** Assembled from pieces so no secret-shaped literal sits in the tree. */
export const NEW_TOKEN = ['al', 'new', 'cli', 'token'].join('_');
export const PROD_TOKEN = ['al', 'prod', 'sentinel', 'token'].join('_');
export const ENV_TOKEN = ['al', 'env', 'sentinel', 'token'].join('_');

export const GW = 'https://api.acme.example';
export const APP = 'https://align.acme.example';

export function linkFor(opts: { app?: string; gw?: string | null; token?: string } = {}): string {
  const app = opts.app ?? APP;
  const gw = opts.gw === undefined ? GW : opts.gw;
  const q = new URLSearchParams({ token: opts.token ?? TOKEN });
  if (gw) q.set('gw', gw);
  return `${app}/join?${q.toString()}`;
}

export interface Seen { url: string; method: string; authorization: string | null; init: Parameters<typeof fetch>[1] }

export interface FakeGatewayOpts {
  /** A peek answered as a raw Response (a stream that never ends, for the size cap). */
  peekResponse?: () => Response;
  peek?: { status: number; body?: unknown } | (() => never);
  me?: { status: number; body?: unknown } | 'unreachable';
}

export const okPeek = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: { org_name: 'Acme Platform', has_email_restriction: false, app_url: APP, gateway_url: GW, ...over },
});
export const okMe = (over: { tenantName?: string } = {}) => ({
  status: 200,
  body: { user: { id: 'u1', email: 'dev@acme.example', role: 'member' }, tenant: { id: 'tenant-acme', name: over.tenantName ?? 'Acme Platform' } },
});
/** A 200 whose body is whatever the test says: for a gateway that answers /auth/me with nonsense. */
export const meBody = (body: unknown) => ({ status: 200, body });

/** Routes every fetch by pathname, whatever the host; records what each request carried. */
export function installFakeGateway(opts: FakeGatewayOpts = {}): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    seen.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization'), init });
    const path = new URL(url).pathname;
    if (path === '/auth/invite-peek') {
      if (opts.peekResponse) return opts.peekResponse();
      const p = opts.peek ?? okPeek();
      if (typeof p === 'function') p();
      const r = p as { status: number; body?: unknown };
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/auth/me') {
      const m = opts.me ?? okMe();
      if (m === 'unreachable') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(m.body ?? {}), { status: m.status, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }));
  return seen;
}

export interface Harness {
  deps: JoinDeps;
  out: string[];
  opened: string[];
  waits: number;
  prompts: string[];
  confirms: string[];
  config: ReturnType<typeof createConfigStore>;
}

export function makeHarness(over: {
  tty?: boolean;
  wrapped?: boolean;
  /** Answers to promptLine, in order; once used up (or never given) it answers `typed`. */
  answers?: Array<string | null>;
  typed?: string | null;
  confirm?: boolean;
  /** Answers to confirm, in order; once used up it answers `confirm`. */
  confirms?: boolean[];
  callback?: Record<string, unknown> | 'reject';
  opened?: boolean;
} = {}): Harness {
  const config = createConfigStore();
  const answers = [...(over.answers ?? [])];
  const confirmQueue = [...(over.confirms ?? [])];
  const h = { out: [] as string[], opened: [] as string[], waits: 0, prompts: [] as string[], confirms: [] as string[] };
  const deps: JoinDeps = {
    config,
    isTTY: over.tty ?? true,
    wrapped: over.wrapped ?? false,
    out: (l) => h.out.push(l),
    openUrl: async (u) => { h.opened.push(u); return over.opened ?? true; },
    promptLine: async (q) => { h.prompts.push(q); const queued = answers.shift(); return queued !== undefined ? queued : over.typed === undefined ? null : over.typed; },
    confirm: async (q) => { h.confirms.push(q); const queued = confirmQueue.shift(); return queued !== undefined ? queued : over.confirm ?? false; },
    waitForCallback: async (o): Promise<CallbackResult> => {
      h.waits += 1;
      await o.onBound?.(7654, 'nonce-fixed');
      if (over.callback === 'reject') throw new Error('timed out');
      return { data: over.callback ?? { token: NEW_TOKEN, expires_at: '2027-01-08T00:00:00.000Z' }, port: 7654 };
    },
    now: () => new Date('2026-10-11T00:00:00Z'),
    callbackPorts: [7654],
    timeoutMs: 1000,
  };
  return Object.assign(h, { deps, config }) as unknown as Harness;
}
