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


describe('waitForLoopbackRedirect, contract edges', () => {
  it('refuses a non-GET even when the state matches', async () => {
    // The handler comment said a browser follows the provider's 302 with a GET, and
    // checked nothing. A POST carrying the right state would have completed the flow:
    // a comment describing a control that is not there, which is the defect class
    // this whole change exists to remove. Caught in review, not by me.
    let bound = 0, state = '';
    const pending = waitForLoopbackRedirect({
      ports: [7811],
      timeoutMs: 400,
      onBound: (port, s) => { bound = port; state = s; },
    });
    await new Promise((r) => setTimeout(r, 50));
    const settled = expect(pending).rejects.toThrow(/timed out/i);
    const res = await fetch(`http://127.0.0.1:${bound}/callback?code=c&state=${state}`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    await settled;
  });

  it('fails fast when onBound rejects, instead of waiting out the timeout', async () => {
    // onBound is where the browser is opened. Discarding that promise made a failure
    // there an unhandled rejection AND left the flow sitting for its full timeout
    // while the user looked at nothing.
    const t0 = Date.now();
    await expect(
      waitForLoopbackRedirect({
        ports: [7812],
        timeoutMs: 30_000,
        onBound: () => Promise.reject(new Error('could not open browser')),
      }),
    ).rejects.toThrow(/could not open browser/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
