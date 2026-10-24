import { describe, expect, it } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import { waitForCallback } from '../lib/cli-oauth.js';

/** Any non-loopback IPv4 address of this machine (what a neighbour on the LAN would dial). */
function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

async function bound(port: number): Promise<{ stop: () => void }> {
  let up!: () => void;
  const ready = new Promise<void>((r) => { up = r; });
  const p = waitForCallback({ ports: [port], timeoutMs: 4000, onBound: () => up() });
  p.catch(() => undefined);
  await ready;
  return { stop: () => undefined };
}

describe('the login loopback binds 127.0.0.1 only (join plan S10)', () => {
  it('accepts a connection on 127.0.0.1', async () => {
    await bound(19911);
    expect(await connects('127.0.0.1', 19911)).toBe(true);
  });

  it.skipIf(lanAddress() === undefined)('refuses a connection to the LAN address on the same port', async () => {
    await bound(19912);
    // Positive control first: the port is live, so a refusal below is the bind, not a dead listener.
    expect(await connects('127.0.0.1', 19912)).toBe(true);
    expect(await connects(lanAddress() as string, 19912)).toBe(false);
  });
});

/** True when this machine can listen on the IPv6 loopback at all (some containers cannot). */
const ipv6Loopback: boolean = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(0, '::1', () => s.close(() => resolve(true)));
});

describe('the page posts to http://localhost, which may resolve to ::1 (contract note)', () => {
  it.skipIf(!ipv6Loopback)('the callback also answers on ::1, and still refuses the LAN address', async () => {
    await bound(19913);
    expect(await connects('::1', 19913)).toBe(true);
    expect(await connects('127.0.0.1', 19913)).toBe(true);
    const lan = lanAddress();
    if (lan) expect(await connects(lan, 19913)).toBe(false);
  });

  it.skipIf(!ipv6Loopback)('when ::1 on a port is already taken by someone else, the next port is used and 127.0.0.1 is not left half-bound', async () => {
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(19914, '::1', r));
    try {
      let boundPort = 0;
      const p = waitForCallback({ ports: [19914, 19915], timeoutMs: 4000, onBound: (port) => { boundPort = port; } });
      p.catch(() => undefined);
      for (let i = 0; i < 100 && boundPort === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(boundPort).toBe(19915);
      // Nothing of ours may be listening on the skipped port's IPv4 side: a browser must not be sent to half of a pair.
      expect(await connects('127.0.0.1', 19914)).toBe(false);
    } finally {
      squatter.close();
    }
  });
});
