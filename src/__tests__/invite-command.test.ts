/**
 * `align invite [email]` - Test List
 *
 * The gateway accepts POST /admin/invites only from an interactive org-admin login, never from
 * an api_token: an agent's token must not add team members. So this command creates nothing. It
 * points the admin at Settings > Team invites in the web app.
 *
 * 1. an invalid email exits 1, prints why, and never touches config or the gateway
 * 2. a local-embedded env exits 1: a local graph has no team and no web app
 * 3. it prints two short lines saying invites are made in the browser by an admin, then the
 *    settings URL, and exits 0 (the client has no createInvite: gateway-client.test.ts)
 * 4. the URL comes from the team destination's saved app, or the gateway's app_url, else the guess
 * 5. at an interactive terminal it opens the URL with the allowlisted opener
 * 6. under ALIGN_WRAPPED, or with no TTY, it only prints
 * 7. when the opener fails it says so and still exits 0
 * 8. teammate_requested still fires for a cloud env (the ALI-938 demand signal)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type * as DeliveryModule from '../lib/share/delivery.js';
import type { DeliveryEnv } from '../lib/share/delivery.js';

const resolveEnv = vi.hoisted(() => vi.fn().mockReturnValue('prod'));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv }));

const getEnvironment = vi.hoisted(() => vi.fn());
vi.mock('../lib/config.js', () => ({ createConfigStore: vi.fn(() => ({ getEnvironment })) }));

const shareRequestsConfig = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ shareRequestsConfig })) }));

const recordFunnelStage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage }));

const delivery = vi.hoisted(() => ({ env: null as DeliveryEnv | null, open: vi.fn() }));
vi.mock('../lib/share/delivery.js', async (orig) => ({
  ...(await orig<typeof DeliveryModule>()),
  currentDeliveryEnv: () => delivery.env,
  openSettingsLink: delivery.open,
}));

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

const PROD = { gatewayUrl: 'https://api.align.tech', authToken: 'tok', tenantId: 'tenant-1', mode: 'auth' };
const TEAM = { kind: 'team', gatewayUrl: 'https://api.acme.example', appUrl: 'https://align.acme.example', authToken: 'tok', tenantId: 't-2', mode: 'auth' };
const TTY: DeliveryEnv = { platform: 'darwin', env: {}, stdoutIsTTY: true, stdinIsTTY: true, inContainer: false };
const text = (): string => out.join('\n');

beforeEach(() => {
  shareRequestsConfig.mockReset().mockResolvedValue({ mode: 'available', pendingTtlS: null, completeTtlS: null, appUrl: null });
  recordFunnelStage.mockClear();
  getEnvironment.mockReset().mockReturnValue(PROD);
  resolveEnv.mockReset().mockReturnValue('prod');
  delivery.env = TTY;
  delivery.open.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.clearAllMocks());

describe('align invite - input', () => {
  it('an invalid email exits 1, says why, and never touches config or the gateway', async () => {
    await run(['not-an-email']);
    expect(exitCode).toBe(1);
    expect(text()).toMatch(/email/i);
    expect(getEnvironment).not.toHaveBeenCalled();
    expect(shareRequestsConfig).not.toHaveBeenCalled();
  });

  it('a local graph exits 1: there is no team or web app to invite into', async () => {
    getEnvironment.mockReturnValue({ gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded', localDbPath: '/tmp/x.db' });
    await run([]);
    expect(exitCode).toBe(1);
    expect(text()).toMatch(/cloud account/i);
    expect(delivery.open).not.toHaveBeenCalled();
  });
});

describe('align invite - points at Settings > Team invites', () => {
  it('explains in two short lines, prints the settings URL, opens it, and exits 0', async () => {
    await run(['dan@acme.example']);
    expect(exitCode).toBeUndefined();
    expect(text()).toContain('Invites are created in the web app, by an org admin.');
    expect(text()).toContain('Open Team invites, create a link for dan@acme.example, and send it to them.');
    expect(text()).toContain('https://app.align.tech/settings?tab=invites');
    expect(delivery.open).toHaveBeenCalledWith('https://app.align.tech/settings?tab=invites', 'https://app.align.tech');
  });

  it('works with no email and says to send the link to the person joining', async () => {
    await run([]);
    expect(exitCode).toBeUndefined();
    expect(text()).toContain('Open Team invites, create a link, and send it to the person joining.');
  });

  it('uses a team destination\'s saved web app', async () => {
    getEnvironment.mockReturnValue(TEAM);
    await run([]);
    expect(text()).toContain('https://align.acme.example/settings?tab=invites');
    expect(delivery.open).toHaveBeenCalledWith('https://align.acme.example/settings?tab=invites', 'https://align.acme.example');
    expect(shareRequestsConfig).not.toHaveBeenCalled();
  });

  it('uses the web app the gateway names for a builtin', async () => {
    shareRequestsConfig.mockResolvedValue({ mode: 'available', pendingTtlS: null, completeTtlS: null, appUrl: 'https://web.selfhost.example' });
    await run([]);
    expect(text()).toContain('https://web.selfhost.example/settings?tab=invites');
  });

  it('only prints inside an agent align launched (ALIGN_WRAPPED)', async () => {
    delivery.env = { ...TTY, env: { ALIGN_WRAPPED: '1' } };
    await run([]);
    expect(exitCode).toBeUndefined();
    expect(text()).toContain('https://app.align.tech/settings?tab=invites');
    expect(delivery.open).not.toHaveBeenCalled();
  });

  it('only prints when stdout or stdin is not a terminal', async () => {
    delivery.env = { ...TTY, stdoutIsTTY: false };
    await run([]);
    delivery.env = { ...TTY, stdinIsTTY: false };
    await run([]);
    expect(text()).toContain('https://app.align.tech/settings?tab=invites');
    expect(delivery.open).not.toHaveBeenCalled();
  });

  it('says so when the browser could not be opened, and still exits 0', async () => {
    delivery.open.mockResolvedValue(false);
    await run([]);
    expect(exitCode).toBeUndefined();
    expect(text()).toContain('Could not open a browser here. Open the link above yourself.');
  });

  it('does not claim a failure when it never tried to open', async () => {
    delivery.env = { ...TTY, stdoutIsTTY: false };
    await run([]);
    expect(text()).not.toContain('Could not open');
  });
});

describe('align invite - the teammate_requested funnel signal (ALI-938)', () => {
  it('fires for a cloud env', async () => {
    await run(['dan@acme.example']);
    expect(recordFunnelStage).toHaveBeenCalledWith(expect.objectContaining({ authToken: 'tok' }), 'teammate_requested', 'invite');
  });

  it('does NOT fire for an invalid email or a local graph', async () => {
    await run(['not-an-email']);
    getEnvironment.mockReturnValue({ gatewayUrl: 'http://x', authToken: null, tenantId: null, mode: 'local-embedded', localDbPath: '/tmp/x.db' });
    await run([]);
    expect(recordFunnelStage).not.toHaveBeenCalled();
  });
});
