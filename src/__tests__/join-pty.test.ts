import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { canPty } from './helpers/share-harness.js';
import { type JoinPtyHarness, MINTED, startJoinHarness } from './helpers/join-pty-harness.js';

/**
 * The real `align join` on a real pseudo-terminal (second review N1: the prompt helper resolved null before the typed answer,
 * so no real person could ever join, and no test noticed because every join test injected its own prompts). Nothing is injected here.
 */
vi.setConfig({ testTimeout: 90_000 });
// Linux only: the browser stand-in rides on xdg-open's $BROWSER fallback; macOS `open` and Windows `start` have no such hook.
const posix = process.platform === 'linux';
let h: JoinPtyHarness;
beforeAll(async () => { if (posix && canPty) h = await startJoinHarness(); });
afterAll(async () => { await h?.close(); });
beforeEach(() => {
  if (!h) return;
  fs.rmSync(h.configFile, { force: true });
  h.requests.length = 0;
  fs.rmSync(`${h.dir}/browser.log`, { force: true });
});

const HOST_PROMPT = 'Type the gateway host to confirm';
const SHARE_PROMPT = '[y/N]';

describe.skipIf(!posix || !canPty)('align join at a terminal, nothing faked', () => {
  it('the typed host is accepted: the destination is saved with the minted token, the browser got cli_gw, and the whoami used only that token', async () => {
    const r = await h.pty([h.link], [[HOST_PROMPT, `${h.host}\n`], [SHARE_PROMPT, 'n\n']]);
    expect(r.out).toContain('Joined as "pty-org"');
    expect(r.code).toBe(0);
    const c = h.config();
    expect(c.environments?.['pty-org']).toMatchObject({ kind: 'team', gatewayUrl: h.base, authToken: MINTED, tenantId: 'tenant-pty' });
    const url = new URL(h.opened()[0] as string);
    expect(url.searchParams.get('cli_gw')).toBe(h.base);
    expect(url.searchParams.get('token')).toBeTruthy();
    expect(h.requests.filter((q) => q.auth).map((q) => q.auth)).toEqual([`Bearer ${MINTED}`]);
  });

  it('a wrong host is refused: nothing saved, no browser, exit 1', async () => {
    const r = await h.pty([h.link], [[HOST_PROMPT, '127.0.0.1:1\n']]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('nothing was done');
    expect(h.config().environments?.['pty-org']).toBeUndefined();
    expect(h.opened()).toEqual([]);
  });

  it('the share-destination question: y sets it and says so, n leaves it unset', async () => {
    const yes = await h.pty([h.link], [[HOST_PROMPT, `${h.host}\n`], [SHARE_PROMPT, 'y\n']]);
    expect(yes.out).toContain('Shares from this machine now go to "Pty Org"');
    expect(h.config().shareDestination).toBe('pty-org');

    fs.rmSync(h.configFile, { force: true });
    const no = await h.pty([h.link], [[HOST_PROMPT, `${h.host}\n`], [SHARE_PROMPT, 'n\n']]);
    expect(no.out).not.toContain('Shares from this machine now go to');
    expect(h.config().environments?.['pty-org']).toBeDefined();
    expect(h.config().shareDestination).toBeUndefined();
  });

  it('--replace: the old and new host are shown, the typed new host is accepted, and replacing the share destination asks again', async () => {
    h.seedConfig({ defaultEnv: 'prod', shareDestination: 'pty-org', environments: { 'pty-org': { kind: 'team', mode: 'auth', gatewayUrl: 'https://api.old.example', appUrl: 'https://align.old.example', authToken: 'old-token-value', tenantId: 'T-old' } } });
    const r = await h.pty([h.link, '--name', 'pty-org', '--replace'], [[HOST_PROMPT, `${h.host}\n`], ['is where', 'y\n']]);
    expect(r.out).toContain('api.old.example');
    expect(r.out).toContain(h.host);
    expect(r.code).toBe(0);
    const c = h.config();
    expect(c.environments?.['pty-org']).toMatchObject({ gatewayUrl: h.base, authToken: MINTED });
    expect(c.shareDestination).toBe('pty-org');
  });

  it('--replace, declined at the share-destination question: the old entry is untouched', async () => {
    h.seedConfig({ defaultEnv: 'prod', shareDestination: 'pty-org', environments: { 'pty-org': { kind: 'team', mode: 'auth', gatewayUrl: 'https://api.old.example', appUrl: 'https://align.old.example', authToken: 'old-token-value', tenantId: 'T-old' } } });
    const r = await h.pty([h.link, '--name', 'pty-org', '--replace'], [[HOST_PROMPT, `${h.host}\n`], ['is where', 'n\n']]);
    expect(r.code).toBe(1);
    expect(h.config().environments?.['pty-org']).toMatchObject({ gatewayUrl: 'https://api.old.example', authToken: 'old-token-value' });
    expect(h.opened()).toEqual([]);
  });

  it('with no terminal at all the real command refuses and touches nothing', async () => {
    const r = await h.plain([h.link]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('needs a terminal');
    expect(h.requests).toEqual([]);
    expect(h.opened()).toEqual([]);
  });

  it('inside an agent align launched (ALIGN_WRAPPED) the real command refuses even on a terminal, before any request', async () => {
    const r = await h.pty([h.link], [[HOST_PROMPT, `${h.host}\n`]], { ALIGN_WRAPPED: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('not from inside an agent');
    expect(h.requests).toEqual([]);
  });
});
