import { describe, expect, it } from 'vitest';
import { waitForLoopbackRedirect } from '../lib/loopback-redirect.js';

/**
 * RFC 8252 loopback redirect: a provider finishing an authorization-code flow sends
 * the browser a GET to http://127.0.0.1:PORT/callback?code=...&state=...
 *
 * The pre-existing waitForCallback cannot serve that. It answers 405 to any
 * non-POST and then requires a JSON body carrying `cli_nonce`, which is the hosted
 * gateway page's contract, not a provider's. So the PKCE half of ALI-778 could
 * never complete regardless of whether a client id was configured.
 */
describe('waitForLoopbackRedirect', () => {
  it('resolves with the code from a GET redirect', async () => {
    let bound = 0, state = '';
    const pending = waitForLoopbackRedirect({
      ports: [7801],
      timeoutMs: 5000,
      onBound: (port, s) => { bound = port; state = s; },
    });
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`http://127.0.0.1:${bound}/callback?code=the-code&state=${state}`);
    expect(res.status).toBe(200);
    await expect(pending).resolves.toMatchObject({ code: 'the-code' });
  });

  it('rejects a redirect whose state does not match, without resolving', async () => {
    let bound = 0, state = '';
    const pending = waitForLoopbackRedirect({
      ports: [7802],
      timeoutMs: 400,
      onBound: (port, s) => { bound = port; state = s; },
    });
    void state;
    await new Promise((r) => setTimeout(r, 50));
    // Attach the rejection handler BEFORE triggering: the promise settles while the
    // fetch is still in flight, and an unattached rejection is an unhandled one.
    const settled = expect(pending).rejects.toThrow(/timed out/i);
    const res = await fetch(`http://127.0.0.1:${bound}/callback?code=x&state=forged`);
    expect(res.status).toBe(403);
    // A stray or forged request must not complete the flow.
    await settled;
  });

  it('surfaces a provider error redirect instead of hanging until timeout', async () => {
    let bound = 0, state = '';
    const pending = waitForLoopbackRedirect({
      ports: [7803],
      timeoutMs: 5000,
      onBound: (port, s) => { bound = port; state = s; },
    });
    await new Promise((r) => setTimeout(r, 50));
    const settled = expect(pending).rejects.toThrow(/access_denied/);
    await fetch(`http://127.0.0.1:${bound}/callback?error=access_denied&state=${state}`);
    await settled;
  });

  it('serves a human-readable page, not JSON, since a browser renders it', async () => {
    let bound = 0, state = '';
    const pending = waitForLoopbackRedirect({
      ports: [7804],
      timeoutMs: 5000,
      onBound: (port, s) => { bound = port; state = s; },
    });
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`http://127.0.0.1:${bound}/callback?code=c&state=${state}`);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/close/i);
    await pending;
  });
});

