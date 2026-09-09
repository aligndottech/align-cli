/**
 * ALI-938: `align invite <email>` - Test List
 *
 * 1. an invalid email exits 1, prints why, and never touches config/gateway
 * 2. env resolves to local-embedded: exits 1, tells the user to log in to a cloud env,
 *    never calls whoami/createInvite
 * 3. not logged in (no token, mode !== demo): exits 1, tells the user to `align login`
 * 4. logged in, personal-email tenant: explains, does NOT call createInvite, exit 0
 * 5. logged in, work-domain member (not org_admin): tells them to ask their admin,
 *    does NOT call createInvite, exit 0
 * 6. logged in, work-domain org_admin: calls createInvite(email), prints the invite URL
 * 7. createInvite throws: prints the message, exits 1
 * 8. teammate_requested fires once the login gate is passed, for the admin success case
 * 9. teammate_requested does NOT fire for an invalid email or when not logged in
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// Each ora(...) call gets its own spinner instance, pushed here so a test can assert on
// SPECIFICALLY the second one created (the invite-in-progress spinner) - a shared/singleton
// mock would hide the "second spinner never stopped" bug this test list's #10 pins.
const spinnerInstances = vi.hoisted(() => [] as Array<{ stop: ReturnType<typeof vi.fn> }>);
vi.mock('ora', () => ({
  default: vi.fn(() => {
    const instance = { start: vi.fn().mockReturnThis(), stop: vi.fn(), fail: vi.fn(), succeed: vi.fn() };
    spinnerInstances.push(instance);
    return instance;
  }),
}));

const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('prod'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));

const getEnvironment = vi.hoisted(() => vi.fn().mockReturnValue({
  gatewayUrl: 'https://api.align.tech', authToken: 'tok', tenantId: 'tenant-1', mode: 'auth',
}));
vi.mock('../lib/config.js', () => ({ createConfigStore: vi.fn(() => ({ getEnvironment })) }));

const whoami = vi.hoisted(() => vi.fn());
const createInvite = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ whoami, createInvite })) }));

const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

import { registerInviteCommand } from '../commands/invite.js';

const out: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });

let exitCode: number | undefined;
vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  exitCode = code;
  throw new Error(`process.exit(${code})`);
}) as never);

async function run(args: string[]): Promise<void> {
  out.length = 0; exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerInviteCommand(program);
  try {
    await program.parseAsync(['node', 'align', 'invite', ...args]);
  } catch (e) {
    if (!/process\.exit/.test((e as Error).message)) throw e;
  }
}

const WORK_ADMIN = { user: { id: 'u1', email: 'tom@align.tech', role: 'org_admin' }, tenant: { id: 't1', name: 'Align' } };
const WORK_MEMBER = { user: { id: 'u2', email: 'dan@align.tech', role: 'member' }, tenant: { id: 't1', name: 'Align' } };
const PERSONAL = { user: { id: 'u3', email: 'me@gmail.com', role: 'org_admin' }, tenant: { id: 't2', name: 'me' } };

beforeEach(() => {
  spinnerInstances.length = 0;
  whoami.mockReset();
  createInvite.mockReset();
  recordFunnelStage.mockClear();
  getEnvironment.mockReset().mockReturnValue({
    gatewayUrl: 'https://api.align.tech', authToken: 'tok', tenantId: 'tenant-1', mode: 'auth',
  });
  resolveEnv.mockReset().mockReturnValue('prod');
});
afterEach(() => vi.clearAllMocks());

describe('align invite - input validation', () => {
  it('an invalid email exits 1, says why, and never touches config or gateway', async () => {
    await run(['not-an-email']);
    expect(exitCode).toBe(1);
    expect(out.join('\n')).toMatch(/email/i);
    expect(getEnvironment).not.toHaveBeenCalled();
    expect(whoami).not.toHaveBeenCalled();
  });
});

describe('align invite - not usable without a cloud account', () => {
  it('local-embedded env: exits 1, points at align login, never calls the gateway', async () => {
    getEnvironment.mockReturnValue({ gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded', localDbPath: '/tmp/x.db' });
    await run(['dan@align.tech']);
    expect(exitCode).toBe(1);
    expect(out.join('\n')).toMatch(/cloud account/i);
    expect(out.join('\n')).toContain('align login');
    expect(whoami).not.toHaveBeenCalled();
  });

  it('not logged in: exits 1, tells the user to run align login', async () => {
    getEnvironment.mockReturnValue({ gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' });
    await run(['dan@align.tech']);
    expect(exitCode).toBe(1);
    expect(out.join('\n')).toMatch(/not logged in/i);
    expect(out.join('\n')).toContain('align login --env prod');
    expect(whoami).not.toHaveBeenCalled();
  });
});

describe('align invite - personal-email tenant', () => {
  it('explains instead of inviting, and never calls createInvite', async () => {
    whoami.mockResolvedValue(PERSONAL);
    await run(['dan@align.tech']);
    expect(exitCode).toBeUndefined();
    expect(out.join('\n')).toMatch(/personal graph/i);
    expect(out.join('\n')).toContain('me@gmail.com');
    expect(createInvite).not.toHaveBeenCalled();
  });
});

describe('align invite - work-domain, not an org_admin', () => {
  it('tells the member to ask their admin, and never calls createInvite', async () => {
    whoami.mockResolvedValue(WORK_MEMBER);
    await run(['dan@align.tech']);
    expect(exitCode).toBeUndefined();
    expect(out.join('\n')).toMatch(/not an admin|ask your org/i);
    expect(out.join('\n')).toContain('align invite dan@align.tech');
    expect(createInvite).not.toHaveBeenCalled();
  });
});

describe('align invite - work-domain org_admin', () => {
  it('creates the invite and prints the link', async () => {
    whoami.mockResolvedValue(WORK_ADMIN);
    createInvite.mockResolvedValue({ inviteId: 'inv-1', inviteUrl: 'https://app.align.tech/join?token=abc' });
    await run(['dan@align.tech']);
    expect(exitCode).toBeUndefined();
    expect(createInvite).toHaveBeenCalledWith('dan@align.tech');
    expect(out.join('\n')).toContain('https://app.align.tech/join?token=abc');
  });

  it('exits 1 and prints the message when the gateway call fails', async () => {
    whoami.mockResolvedValue(WORK_ADMIN);
    createInvite.mockRejectedValue(new Error('Gateway returned 429 for /admin/invites: rate limited'));
    await run(['dan@align.tech']);
    expect(exitCode).toBe(1);
    expect(out.join('\n')).toContain('rate limited');
  });

  it('stops the invite-in-progress spinner, not just the whoami one, when createInvite rejects (Copilot review)', async () => {
    // Two spinners exist on this path: one for "Checking your account...", replaced by a
    // SECOND one for "Inviting <email>..." once whoami succeeds. An error thrown by
    // createInvite is caught in a handler that used to reference only the first spinner by
    // name, so the second kept spinning forever on any createInvite failure (403/429/network).
    whoami.mockResolvedValue(WORK_ADMIN);
    createInvite.mockRejectedValue(new Error('network error'));
    await run(['dan@align.tech']);

    expect(spinnerInstances).toHaveLength(2);
    expect(spinnerInstances[0].stop).toHaveBeenCalled(); // the whoami spinner
    expect(spinnerInstances[1].stop).toHaveBeenCalled(); // the invite spinner - the regression
  });
});

describe('align invite - the teammate_requested funnel signal (ALI-938)', () => {
  it('fires once the login gate is passed, for the admin success path', async () => {
    whoami.mockResolvedValue(WORK_ADMIN);
    createInvite.mockResolvedValue({ inviteId: 'inv-1', inviteUrl: 'https://app.align.tech/join?token=abc' });
    await run(['dan@align.tech']);
    expect(recordFunnelStage).toHaveBeenCalledWith(
      expect.objectContaining({ authToken: 'tok' }),
      'teammate_requested',
      'invite',
    );
  });

  it('fires for a blocked member too - demand exists even when the invite is not sent', async () => {
    whoami.mockResolvedValue(WORK_MEMBER);
    await run(['dan@align.tech']);
    expect(recordFunnelStage).toHaveBeenCalledWith(expect.anything(), 'teammate_requested', 'invite');
  });

  it('does NOT fire for an invalid email', async () => {
    await run(['not-an-email']);
    expect(recordFunnelStage).not.toHaveBeenCalled();
  });

  it('does NOT fire when not logged in', async () => {
    getEnvironment.mockReturnValue({ gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' });
    await run(['dan@align.tech']);
    expect(recordFunnelStage).not.toHaveBeenCalled();
  });
});
