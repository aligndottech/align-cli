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

describe('the login loopback binds 127.0.0.1 only (ALI-1504, join plan S10)', () => {
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
