import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `align connect linear` says when its read hit a limit, by behaviour (the warning clack prints), not by reading the source:
 * - A read that stops at a --limit the person gave says it stopped at THEIR limit and there may be more.
 * - A read under the limit says nothing.
 */
const warn = vi.hoisted(() => vi.fn());
const fetchLinear = vi.hoisted(() => vi.fn());
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(), outro: vi.fn(), cancel: vi.fn(), note: vi.fn(), confirm: vi.fn(), isCancel: () => false,
  log: { info: vi.fn(), error: vi.fn(), warn, success: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));
vi.mock('../lib/fetchers/linear.js', () => ({ fetchLinearItems: fetchLinear }));
vi.mock('../lib/personal-import.js', () => ({ runPersonalImport: vi.fn() }));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({})) }));
vi.mock('../lib/env-resolver.js', () => ({ resolveAppUrl: vi.fn(() => 'https://app.align.tech') }));
vi.mock('../lib/resolve-env.js', () => ({ resolveImportEnv: vi.fn(() => 'prod') }));
vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getEnvironment: vi.fn(() => ({ gatewayUrl: 'https://api.align.tech', authToken: null, tenantId: null, mode: 'auth' })),
    getConnectorToken: vi.fn(() => null), getConnectorCloudId: vi.fn(() => null), getConnectorSiteBase: vi.fn(() => null),
    isTeamScopeDisclosed: vi.fn(() => false), markTeamScopeDisclosed: vi.fn(), getConnectorScope: () => null,
  })),
}));

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ source_url: `u${i}`, platform: 'linear', raw_text: 't' }));
async function run(args: string[]): Promise<void> {
  const { registerImportLinearCommand } = await import('../commands/import/linear.js');
  const program = new Command();
  program.exitOverride();
  registerImportLinearCommand(program.command('connect'));
  await program.parseAsync(['connect', 'linear', '--token', 't', ...args], { from: 'user' });
}
beforeEach(() => { warn.mockClear(); vi.spyOn(console, 'log').mockImplementation(() => undefined); });

describe('align connect linear, a read that hit a limit', () => {
  it('stopped at the limit the person gave: says so, and that there may be more', async () => {
    fetchLinear.mockResolvedValue({ items: items(3), report: { scanned: 3, skips: [], complete: true } });
    await run(['--limit', '3']);
    expect(String(warn.mock.calls[0]?.[0])).toContain('stopped at the limit you gave (3)');
  });
  it('under the limit: nothing to say', async () => {
    fetchLinear.mockResolvedValue({ items: items(2), report: { scanned: 2, skips: [], complete: true } });
    await run(['--limit', '3']);
    expect(warn).not.toHaveBeenCalled();
  });
});
