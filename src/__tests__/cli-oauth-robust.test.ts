import { describe, expect, it } from 'vitest';
import { waitForCallback } from '../lib/cli-oauth.js';

/**
 * Join review F8: the loopback is reachable by any web page (a no-cors POST), so a stray request must never end the wait,
 * and a body must never be read without a bound. Only the right nonce completes it.
 */
async function start(port: number) {
  let nonce = '';
  const p = waitForCallback({ ports: [port], timeoutMs: 4000, onBound: (_p, n) => { nonce = n; } });
  const settled = { done: false };
  p.then(() => { settled.done = true; }, () => { settled.done = true; });
  for (let i = 0; i < 100 && nonce === ''; i++) await new Promise((r) => setTimeout(r, 10));
  const post = (body: string, type = 'text/plain;charset=UTF-8') =>
    fetch(`http://127.0.0.1:${port}/callback`, { method: 'POST', headers: { 'content-type': type }, body });
  return { p, nonce, post, settled };
}

describe('the login loopback callback ignores what is not the answer', () => {
  it('invalid JSON gets 400 and the wait goes on: the real post still completes it', async () => {
    const { p, nonce, post, settled } = await start(19921);
    expect((await post('not json')).status).toBe(400);
    expect(settled.done).toBe(false);
    await post(JSON.stringify({ token: 'tok', cli_nonce: nonce }));
    expect((await p).data).toEqual({ token: 'tok' });
  });

  it.each([['null'], ['[]'], ['7'], ['"x"']])('JSON that is not an object (%s) gets 400 and does not end the wait', async (body) => {
    const { p, nonce, post, settled } = await start(19922);
    expect((await post(body)).status).toBe(400);
    expect(settled.done).toBe(false);
    await post(JSON.stringify({ token: 'tok', cli_nonce: nonce }));
    await p;
  });

  it('a body over 8 KB is refused and does not end the wait', async () => {
    const { p, nonce, post, settled } = await start(19923);
    const r = await post(JSON.stringify({ token: 'x'.repeat(9000), cli_nonce: nonce }));
    expect(r.status).toBe(413);
    expect(settled.done).toBe(false);
    await post(JSON.stringify({ token: 'tok', cli_nonce: nonce }));
    expect((await p).data).toEqual({ token: 'tok' });
  });

  it('a body just under the cap is accepted (the boundary is on the right side)', async () => {
    const { p, nonce, post } = await start(19924);
    const token = 'x'.repeat(8 * 1024 - 100);
    await post(JSON.stringify({ token, cli_nonce: nonce }));
    expect(((await p).data['token'] as string).length).toBe(token.length);
  });

  it('a wrong nonce is 403 and the right one still completes it; any content type is read as JSON', async () => {
    const { p, nonce, post, settled } = await start(19925);
    expect((await post(JSON.stringify({ token: 'bad', cli_nonce: 'nope' }), 'application/json')).status).toBe(403);
    expect(settled.done).toBe(false);
    await post(JSON.stringify({ token: 'tok', cli_nonce: nonce }), 'application/x-www-form-urlencoded');
    expect((await p).data).toEqual({ token: 'tok' });
  });
});
