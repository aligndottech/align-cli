/**
 * Test List, the one-line offer to turn a decision into tickets (smallest useful version: `align capture <url>` only):
 * - offered once, as one line, to a person at a terminal who has just captured ONE plan-shaped decision with a tracker connected:
 *   the decision lists actions, or it is an ADR (title or file name).
 * - never offered: with no terminal, in CI, in a launched agent (ALIGN_WRAPPED), in a hook, over the MCP capture tool,
 *   for a bulk import (more than one decision), when switched off in config or by ALIGN_NO_BACKLOG_OFFER,
 *   when the decision is not plan-shaped, when no tracker is connected, or when the capture failed.
 * - the line names the tracker when it is known (the saved one, else the only one connected) and says nothing about one otherwise.
 * - `align config backlog-offer off` and `on` switch it, and the config reads on by default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { backlogOffer, isPlanShaped, type OfferInput } from '../lib/backlog/offer.js';

const base = (o: Partial<OfferInput> = {}): OfferInput => ({
  env: {}, tty: true, inCi: false, inHook: false, enabled: true, count: 1, trackers: ['linear'],
  decision: { id: 'd1', title: 'Use Redis', source_url: null, ai: { actions: [{ text: 'Add a Redis client' }] } }, ...o,
});

describe('backlogOffer', () => {
  it('offers one line naming the only connected tracker', () => {
    expect(backlogOffer(base())).toEqual({ line: 'Turn this into tickets in Linear? align backlog d1' });
  });
  it('names the saved tracker over the others, and none when it cannot tell', () => {
    expect(backlogOffer(base({ trackers: ['linear', 'github'], saved: 'github' }))).toEqual({ line: 'Turn this into tickets in GitHub Issues? align backlog d1' });
    expect(backlogOffer(base({ trackers: ['linear', 'github'] }))).toEqual({ line: 'Turn this into tickets? align backlog d1' });
  });
  it.each<[string, Partial<OfferInput>, string]>([
    ['switched off in config', { enabled: false }, 'off'],
    ['switched off by the environment', { env: { ALIGN_NO_BACKLOG_OFFER: '1' } }, 'off'],
    ['a launched agent', { env: { ALIGN_WRAPPED: '1' } }, 'wrapped'],
    ['CI', { inCi: true }, 'ci'],
    ['a hook', { inHook: true }, 'hook'],
    ['no terminal', { tty: false }, 'not-a-terminal'],
    ['a bulk import', { count: 40 }, 'bulk'],
    ['no tracker connected', { trackers: [] }, 'no-tracker'],
    ['a decision with no plan in it', { decision: { id: 'd1', title: 'We prefer tabs', source_url: null, ai: { actions: [] } } }, 'not-plan-shaped'],
  ])('is silent for %s', (_n, o, why) => {
    expect(backlogOffer(base(o))).toEqual({ skip: why });
  });
  it('treats an empty ALIGN_NO_BACKLOG_OFFER as not set', () => {
    expect(backlogOffer(base({ env: { ALIGN_NO_BACKLOG_OFFER: '' } }))).toHaveProperty('line');
  });
});

describe('what is plan-shaped', () => {
  it.each([
    ['listed actions', { id: 'x', title: 'Use Redis', ai: { actions: [{ text: 'a' }] } }, true],
    ['an ADR by title', { id: 'x', title: 'ADR-0007: Use Postgres', ai: {} }, true],
    ['an ADR by file', { id: 'x', title: 'Use Postgres', source_url: 'https://github.com/o/r/blob/main/docs/adr/0007-use-postgres.md' }, true],
    ['a numbered decisions file', { id: 'x', title: 'Use Postgres', source_url: 'https://github.com/o/r/blob/main/docs/decisions/0007-use-postgres.md' }, true],
    ['a plain preference', { id: 'x', title: 'We prefer tabs', source_url: 'https://github.com/o/r/pull/3', ai: { actions: [] } }, false],
    ['a title that only starts like the word', { id: 'x', title: 'Adrian owns billing' }, false],
  ])('%s', (_n, d, want) => { expect(isPlanShaped(d)).toBe(want); });
});

// The capture command, end to end up to the network: the client is the only fake.
const spinner = vi.hoisted(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn(), fail: vi.fn(), stop: vi.fn() }));
vi.mock('ora', () => ({ default: vi.fn(() => spinner) }));
vi.mock('../lib/resolve-env.js', () => ({ resolveEnv: vi.fn().mockReturnValue('prod') }));
const CFG = vi.hoisted(() => ({ offer: true as boolean, fields: { linear: { token: 't' } } as Record<string, Record<string, string> | null> }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn().mockReturnValue({ mode: 'cloud' }),
    getBacklogOffer: () => CFG.offer,
    getConnectorFields: (_e: string, t: string) => CFG.fields[t] ?? null,
  })),
}));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn().mockReturnValue('https://app.example') }));
const captureDecision = vi.hoisted(() => vi.fn());
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({ captureDecision })) }));
vi.mock('../lib/usage-telemetry.js', () => ({ recordFunnelStage: vi.fn().mockResolvedValue(true) }));
vi.mock('../lib/backlog/deps.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), backlogRepoKey: async () => 'repo-key' }));
vi.mock('../lib/backlog/targets.js', () => ({ getSavedTarget: () => undefined, putSavedTarget: () => undefined }));

import { registerCaptureCommand } from '../commands/capture.js';
import { markHookContext, resetHookContextForTests } from '../lib/hook-context.js';
import { dispatchTool } from '../commands/mcp.js';

const logs: string[] = [];
vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
vi.spyOn(console, 'error').mockImplementation(() => undefined);
vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`); }) as never);

const PLAN = { id: 'd1', title: 'Use Redis', summary: 's', platform: 'github', ai: { actions: [{ text: 'Add a Redis client' }] } };
const saved = { in: process.stdin.isTTY, out: process.stdout.isTTY, env: { ...process.env } };
const tty = (on: boolean) => { Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true }); Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true }); };
async function capture(url = 'https://github.com/acme/repo/pull/1'): Promise<void> {
  const program = new Command(); program.exitOverride(); registerCaptureCommand(program);
  try { await program.parseAsync(['node', 'align', 'capture', url]); } catch (e) { if (!/process\.exit/.test((e as Error).message)) throw e; }
}
const offered = () => logs.some((l) => l.includes('align backlog d1'));

beforeEach(() => {
  logs.length = 0; CFG.offer = true; CFG.fields = { linear: { token: 't' } };
  for (const k of ['ALIGN_WRAPPED', 'ALIGN_NO_BACKLOG_OFFER', 'CI', 'GITHUB_ACTIONS']) delete process.env[k];
  process.env['CI'] = 'false';
  tty(true); resetHookContextForTests(); captureDecision.mockReset(); captureDecision.mockResolvedValue(PLAN);
});
afterEach(() => {
  tty(false);
  Object.defineProperty(process.stdin, 'isTTY', { value: saved.in, configurable: true }); Object.defineProperty(process.stdout, 'isTTY', { value: saved.out, configurable: true });
  process.env = { ...saved.env };
});

describe('align capture offers tickets, at most once and only to a person', () => {
  it('offers after a captured plan-shaped decision at a terminal, as one line', async () => {
    await capture();
    expect(logs.filter((l) => l.includes('align backlog'))).toEqual(['Turn this into tickets in Linear? align backlog d1']);
  });
  it.each<[string, () => void]>([
    ['no terminal', () => tty(false)],
    ['CI', () => { process.env['CI'] = 'true'; }],
    ['a launched agent', () => { process.env['ALIGN_WRAPPED'] = '1'; }],
    ['a hook', () => markHookContext()],
    ['the config switch', () => { CFG.offer = false; }],
    ['ALIGN_NO_BACKLOG_OFFER', () => { process.env['ALIGN_NO_BACKLOG_OFFER'] = '1'; }],
    ['no connected tracker', () => { CFG.fields = {}; }],
    ['a decision with no plan in it', () => captureDecision.mockResolvedValue({ ...PLAN, ai: { actions: [] } })],
    ['a failed capture', () => captureDecision.mockRejectedValue(new Error('boom'))],
  ])('says nothing for %s', async (_n, setUp) => {
    setUp();
    await capture();
    // Positive control: with nothing set up the same run DOES offer (first test), so silence here is the gate.
    expect(offered()).toBe(false);
  });
  it('the MCP capture tool never offers it, even on a terminal with a plan-shaped decision', async () => {
    const client = { captureDecision: vi.fn().mockResolvedValue(PLAN) };
    const env = { mode: 'auth', gatewayUrl: 'https://api.align.tech', authToken: 't' } as never;
    const result = await dispatchTool('align_capture', { input: 'https://github.com/acme/repo/pull/1' }, client as never, env);
    expect(client.captureDecision).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/backlog/i);
    expect(logs.join('\n')).not.toMatch(/backlog/i);
  });
});
