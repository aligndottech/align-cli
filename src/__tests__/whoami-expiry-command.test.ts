import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mockWhoami = vi.hoisted(() => vi.fn());
vi.mock('../lib/config.js', () => ({
  createConfigStore: () => ({
    getEnvironment: () => ({ gatewayUrl: 'https://gw', authToken: 'tok', tenantId: 't1', mode: 'auth' }),
  }),
}));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: () => 'prod' }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: () => ({ whoami: mockWhoami }) }));

import { registerLoginCommands } from '../commands/login.js';

const ME = { user: { id: 'u', email: 'a@b.com', role: 'org_admin' }, tenant: { id: 't1', name: 'Acme' } };
const lines: string[] = [];

async function runWhoami(me: object) {
  mockWhoami.mockResolvedValue(me);
  lines.length = 0;
  const program = new Command();
  registerLoginCommands(program);
  await program.parseAsync(['node', 'align', 'whoami']);
  return lines.join('\n');
}

describe('align whoami login expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('prints the expiry line when the gateway sends a future expires_at', async () => {
    const out = await runWhoami({ ...ME, expires_at: '2027-01-19T12:00:00Z' });
    expect(out).toContain('Login expires: 2027-01-19 (in 90 days)');
    expect(out).toContain('a@b.com');
  });

  it('says the login expired and names align login when the date has passed', async () => {
    const out = await runWhoami({ ...ME, expires_at: '2026-10-01T00:00:00Z' });
    expect(out).toContain('Login expired: 2026-10-01. Run: align login');
  });

  it.each([['null', { ...ME, expires_at: null }], ['absent (older gateway)', ME]])('prints nothing about expiry when expires_at is %s', async (_n, me) => {
    const out = await runWhoami(me);
    expect(out).toContain('a@b.com');
    expect(out.toLowerCase()).not.toMatch(/expir|never/);
  });
});
