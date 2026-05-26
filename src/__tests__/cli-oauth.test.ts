import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { CLI_CALLBACK_PORTS, waitForCallback } from '../lib/cli-oauth.js';

describe('waitForCallback', () => {
  it('resolves with POSTed JSON body and the bound port', async () => {
    let capturedNonce = '';
    const promise = waitForCallback({
      ports: [19876],
      timeoutMs: 3000,
      onBound: (_port, nonce) => { capturedNonce = nonce; },
    });
    // Wait for server to bind and nonce to be captured
    await new Promise<void>(r => {
      const interval = setInterval(() => {
        if (capturedNonce) { clearInterval(interval); r(); }
      }, 10);
    });
    await fetch('http://localhost:19876/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'algt_test', cli_nonce: capturedNonce }),
    });
    const result = await promise;
    expect(result.data).toEqual({ token: 'algt_test' });
    expect(result.port).toBe(19876);
  });

  it('strips cli_nonce from the resolved data', async () => {
    let capturedNonce = '';
    const promise = waitForCallback({
      ports: [19882],
      timeoutMs: 3000,
      onBound: (_port, nonce) => { capturedNonce = nonce; },
    });
    await new Promise<void>(r => {
      const interval = setInterval(() => {
        if (capturedNonce) { clearInterval(interval); r(); }
      }, 10);
    });
    await fetch('http://localhost:19882/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok', cli_nonce: capturedNonce }),
    });
    const result = await promise;
    expect(result.data).not.toHaveProperty('cli_nonce');
    expect(result.data).toEqual({ token: 'tok' });
  });

  it('rejects with 403 when cli_nonce is wrong', async () => {
    const serverReady = waitForCallback({ ports: [19883], timeoutMs: 3000 });
    await new Promise(r => setTimeout(r, 60));
    const res = await fetch('http://localhost:19883/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'bad', cli_nonce: 'wrong-nonce' }),
    });
    expect(res.status).toBe(403);
    // Server should still be listening (not resolved/rejected on bad nonce)
    serverReady.catch(() => {}); // suppress unhandled rejection from timeout
  });

  it('tries next port when first is busy', async () => {
    const blocker = http.createServer();
    await new Promise<void>(r => blocker.listen(19877, r));
    try {
      let capturedNonce = '';
      const promise = waitForCallback({
        ports: [19877, 19878],
        timeoutMs: 3000,
        onBound: (_port, nonce) => { capturedNonce = nonce; },
      });
      await new Promise<void>(r => {
        const interval = setInterval(() => {
          if (capturedNonce) { clearInterval(interval); r(); }
        }, 10);
      });
      await fetch('http://localhost:19878/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'fallback', cli_nonce: capturedNonce }),
      });
      const result = await promise;
      expect(result.data).toEqual({ token: 'fallback' });
      expect(result.port).toBe(19878);
    } finally {
      blocker.close();
    }
  });

  it('handles OPTIONS preflight with 204', async () => {
    const promise = waitForCallback({ ports: [19884], timeoutMs: 3000 });
    await new Promise(r => setTimeout(r, 60));
    const res = await fetch('http://localhost:19884/callback', {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://app.align.tech', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.align.tech');
    promise.catch(() => {}); // suppress timeout rejection
  });

  it('rejects after timeout', async () => {
    await expect(
      waitForCallback({ ports: [19879], timeoutMs: 100 })
    ).rejects.toThrow('timed out');
  });

  it('rejects when all ports are busy', async () => {
    const blockers = [19880, 19881].map(p => {
      const s = http.createServer();
      return new Promise<http.Server>(r => s.listen(p, () => r(s)));
    });
    const servers = await Promise.all(blockers);
    try {
      await expect(
        waitForCallback({ ports: [19880, 19881], timeoutMs: 500 })
      ).rejects.toThrow('No available port');
    } finally {
      servers.forEach(s => s.close());
    }
  });

  it('exports CLI_CALLBACK_PORTS as a non-empty array of numbers', () => {
    expect(Array.isArray(CLI_CALLBACK_PORTS)).toBe(true);
    expect(CLI_CALLBACK_PORTS.length).toBeGreaterThan(0);
    expect(CLI_CALLBACK_PORTS.every(p => typeof p === 'number')).toBe(true);
  });
});
