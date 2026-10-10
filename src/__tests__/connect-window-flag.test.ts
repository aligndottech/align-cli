import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectLocalSources = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('../commands/setup.js', () => ({ connectLocalSources }));
vi.mock('../lib/local-mode.js', () => ({ initLocalMode: vi.fn().mockResolvedValue({ dbPath: '/ignored/graph.db' }) }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({})) }));
vi.mock('../lib/resolve-env.js', () => ({ resolveImportEnv: vi.fn(() => 'local') }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({ getEnvironment: vi.fn(() => ({ mode: 'local-embedded', localDbPath: '/ignored/graph.db' })) })),
}));

import { runConnect } from '../commands/connect.js';

/**
 * L4: the window a connect actually read reaches the scope code only when the person gave --since: it is what a NEW scope row records,
 * so the next sync does not read everything again. Without --since the source's own window applies, so nothing is passed.
 */
beforeEach(() => { connectLocalSources.mockClear(); vi.spyOn(console, 'log').mockImplementation(() => {}); });

describe('--since reaches the scope code', () => {
  it('a given --since becomes windowSince (a date; and null for all), beside any scope flags', async () => {
    await runConnect({ source: 'jira', yes: true, since: '30d', scopeFlags: { projects: 'ALI' } });
    const flags = connectLocalSources.mock.calls[0]![0].scopeFlags as { projects?: string; windowSince?: string | null };
    expect(flags.projects).toBe('ALI');
    expect(typeof flags.windowSince).toBe('string');
    expect(Number.isNaN(Date.parse(flags.windowSince as string))).toBe(false);
    await runConnect({ source: 'jira', yes: true, since: 'all' });
    expect(connectLocalSources.mock.calls[1]![0].scopeFlags).toEqual({ windowSince: null });
  });

  it('with no --since and no scope flags nothing is passed', async () => {
    await runConnect({ source: 'jira', yes: true });
    expect('scopeFlags' in connectLocalSources.mock.calls[0]![0]).toBe(false);
  });
});
