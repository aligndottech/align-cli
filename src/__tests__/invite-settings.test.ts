/**
 * `align invite` points the admin at Settings > Team invites in the web app, because the gateway
 * refuses POST /admin/invites from an api_token (an agent's token must not add team members).
 *
 * Test List
 * 1. the web app is a team destination's saved appUrl, and the gateway is not asked
 * 2. a builtin with a token takes the gateway's app_url when it is a usable origin
 * 3. a builtin falls back to the guess (the hosted app for prod) when the gateway gives no
 *    app_url, an unusable one, or fails; and without a token the gateway is not asked
 * 4. the settings URL is <app>/settings?tab=invites
 * 5. checkSettingsLink accepts exactly that shape on the app's origin, and nothing else
 * 6. openSettingsLink spawns the OS opener with the link as one argument, and never for a link
 *    the allowlist refuses
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';
import { inviteSettingsUrl, resolveInviteAppUrl } from '../lib/invite-settings.js';
import { checkSettingsLink } from '../lib/share/approve-link.js';
import { openSettingsLink } from '../lib/share/delivery.js';

const prod: EnvironmentConfig = { gatewayUrl: 'https://api.align.tech', authToken: 'tok', tenantId: 't-1', mode: 'auth' } as EnvironmentConfig;
const preview: EnvironmentConfig = { gatewayUrl: 'https://api.preview.align.tech', authToken: 'tok', tenantId: 't-1', mode: 'auth' } as EnvironmentConfig;
const team = (appUrl: string): EnvironmentConfig => ({ kind: 'team', gatewayUrl: 'https://api.acme.example', appUrl, authToken: 'tok', tenantId: 't-1', mode: 'auth' }) as EnvironmentConfig;

describe('resolveInviteAppUrl', () => {
  it('uses a team destination\'s saved web app and does not ask the gateway', async () => {
    const ask = vi.fn();
    expect(await resolveInviteAppUrl(team('https://align.acme.example'), ask)).toBe('https://align.acme.example');
    expect(await resolveInviteAppUrl(team('https://app.other.example/'), ask)).toBe('https://app.other.example');
    expect(ask).not.toHaveBeenCalled();
  });

  it('takes the gateway\'s app_url for a builtin with a token', async () => {
    expect(await resolveInviteAppUrl(prod, async () => 'https://web.acme.example')).toBe('https://web.acme.example');
    expect(await resolveInviteAppUrl(preview, async () => 'http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('falls back to the guess when the gateway gives no app_url', async () => {
    expect(await resolveInviteAppUrl(prod, async () => null)).toBe('https://app.align.tech');
    expect(await resolveInviteAppUrl(preview, async () => null)).toBe('https://app.preview.align.tech');
  });

  it('falls back to the guess when the gateway\'s app_url is not a plain https origin', async () => {
    expect(await resolveInviteAppUrl(prod, async () => 'http://web.acme.example')).toBe('https://app.align.tech');
    expect(await resolveInviteAppUrl(prod, async () => 'https://web.acme.example/path')).toBe('https://app.align.tech');
  });

  it('falls back to the guess when asking the gateway fails', async () => {
    expect(await resolveInviteAppUrl(prod, async () => { throw new Error('Gateway returned 401'); })).toBe('https://app.align.tech');
    expect(await resolveInviteAppUrl(preview, async () => { throw new Error('ECONNREFUSED'); })).toBe('https://app.preview.align.tech');
  });

  it('does not ask the gateway without a token', async () => {
    const ask = vi.fn(async () => 'https://web.acme.example');
    expect(await resolveInviteAppUrl({ ...prod, authToken: null } as EnvironmentConfig, ask)).toBe('https://app.align.tech');
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('inviteSettingsUrl', () => {
  it('is the Team invites tab of the web app', () => {
    expect(inviteSettingsUrl('https://app.align.tech')).toBe('https://app.align.tech/settings?tab=invites');
    expect(inviteSettingsUrl('http://localhost:5173')).toBe('http://localhost:5173/settings?tab=invites');
  });
});

describe('checkSettingsLink', () => {
  const APP = 'https://app.align.test';
  it('accepts the settings link on the app\'s own origin', () => {
    expect(checkSettingsLink(`${APP}/settings?tab=invites`, APP).ok).toBe(true);
    expect(checkSettingsLink('http://localhost:5173/settings?tab=invites', 'http://localhost:5173').ok).toBe(true);
  });
  it('refuses any other shape, origin or scheme', () => {
    const bad = [
      'https://evil.example/settings?tab=invites',
      `${APP}/settings?tab=invites&x=1`,
      `${APP}/settings?tab=api-tokens`,
      `${APP}/settings?tab=invites"; calc`,
      `${APP}/settings?tab=invites\n`,
      'http://app.align.test/settings?tab=invites',
      'javascript:alert(1)',
    ];
    for (const b of bad) expect(checkSettingsLink(b, APP).ok, b).toBe(false);
    expect(checkSettingsLink('http://app.align.test/settings?tab=invites', 'http://app.align.test').ok).toBe(false);
  });
});

function fakeSpawn(exit: number | 'error') {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const spawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
    child.pid = 1; child.unref = () => undefined;
    setTimeout(() => { if (exit === 'error') child.emit('error', new Error('ENOENT')); else child.emit('exit', exit); }, 0);
    return child;
  }) as never;
  return { calls, spawn };
}

describe('openSettingsLink', () => {
  const APP = 'https://app.align.test';
  const LINK = `${APP}/settings?tab=invites`;
  it('spawns the OS opener once, with the link as one argument and no shell', async () => {
    const f = fakeSpawn(0);
    expect(await openSettingsLink(LINK, APP, { platform: 'linux', spawn: f.spawn, graceMs: 50 })).toBe(true);
    expect(f.calls).toEqual([{ command: 'xdg-open', args: [LINK], options: expect.objectContaining({ stdio: 'ignore' }) }]);
    expect(f.calls[0]!.options['shell']).toBeFalsy();
  });
  it('reports failure when the opener fails', async () => {
    expect(await openSettingsLink(LINK, APP, { platform: 'linux', spawn: fakeSpawn(3).spawn, graceMs: 50 })).toBe(false);
    expect(await openSettingsLink(LINK, APP, { platform: 'darwin', spawn: fakeSpawn('error').spawn, graceMs: 50 })).toBe(false);
  });
  it('never spawns for a link the allowlist refuses', async () => {
    const f = fakeSpawn(0);
    expect(await openSettingsLink('https://evil.example/settings?tab=invites', APP, { platform: 'linux', spawn: f.spawn, graceMs: 20 })).toBe(false);
    expect(await openSettingsLink(`${LINK}"; calc`, APP, { platform: 'win32', spawn: f.spawn, graceMs: 20 })).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
