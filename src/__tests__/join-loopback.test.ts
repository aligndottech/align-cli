/** `align join` end to end over real loopback sockets: a fake gateway, the real callback server, a fake browser. */
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEW_TOKEN, TOKEN } from './helpers/join-harness.js';
import { createConfigStore } from '../lib/config.js';
import { runJoin } from '../lib/join-flow.js';
import { waitForCallback } from '../lib/cli-oauth.js';

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

let server: http.Server;
let base = '';
const seenAuth: Array<string | undefined> = [];

beforeEach(async () => {
  seenAuth.length = 0;
  server = http.createServer((req, res) => {
    seenAuth.push(req.headers['authorization']);
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/auth/invite-peek')) {
      res.end(JSON.stringify({ org_name: 'Loop Org', has_email_restriction: false, app_url: base, gateway_url: base }));
    } else if (req.url === '/auth/me') {
      res.end(JSON.stringify({ user: { id: 'u', email: 'dev@loop.example', role: 'member' }, tenant: { id: 't-loop', name: 'Loop Org' } }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('join over real sockets', () => {
  it('the page posts the token to the 127.0.0.1 loopback with the nonce; the destination is saved', async () => {
    const config = createConfigStore();
    const out: string[] = [];
    const host = new URL(base).host;
    const result = await runJoin({
      config,
      isTTY: true,
      wrapped: false,
      out: (l) => out.push(l),
      // The fake browser: read the callback port and nonce out of the URL the CLI opened and
      // do what the web app's join page does after the person clicks the button.
      openUrl: async (url) => {
        const u = new URL(url);
        await fetch(`http://127.0.0.1:${u.searchParams.get('cli_port')}/callback`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ token: NEW_TOKEN, cli_nonce: u.searchParams.get('cli_nonce'), expires_at: '2027-01-08T00:00:00.000Z' }),
        });
        return true;
      },
      promptLine: async () => host,
      confirm: async () => false,
      waitForCallback,
      now: () => new Date('2026-10-11T00:00:00Z'),
      callbackPorts: [19931, 19932],
      timeoutMs: 5000,
    }, { link: `${base}/join?token=${TOKEN}&gw=${encodeURIComponent(base)}` });

    expect(result).toMatchObject({ ok: true, name: 'loop-org', expiresAt: '2027-01-08T00:00:00.000Z' });
    expect(config.getEnvironment('loop-org')).toMatchObject({ gatewayUrl: base, authToken: NEW_TOKEN, tenantId: 't-loop' });
    expect(seenAuth.filter((a) => a !== undefined)).toEqual([`Bearer ${NEW_TOKEN}`]);
    expect(out.join('\n')).toContain('Loop Org');
  });

  it('a callback with the wrong nonce is ignored, and nothing is saved when no right one arrives', async () => {
    const config = createConfigStore();
    const host = new URL(base).host;
    const result = await runJoin({
      config,
      isTTY: true,
      wrapped: false,
      out: () => undefined,
      openUrl: async (url) => {
        const u = new URL(url);
        const r = await fetch(`http://127.0.0.1:${u.searchParams.get('cli_port')}/callback`, {
          method: 'POST',
          body: JSON.stringify({ token: NEW_TOKEN, cli_nonce: 'not-the-nonce' }),
        });
        expect(r.status).toBe(403);
        return true;
      },
      promptLine: async () => host,
      confirm: async () => false,
      waitForCallback,
      now: () => new Date(),
      callbackPorts: [19933],
      timeoutMs: 400,
    }, { link: `${base}/join?token=${TOKEN}&gw=${encodeURIComponent(base)}` });
    expect(result.ok).toBe(false);
    expect(config.listTeamDestinationNames()).toEqual([]);
  });
});
