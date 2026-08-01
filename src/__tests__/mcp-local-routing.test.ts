import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../lib/config.js';

/**
 * `align mcp` resolved its environment without `preferLocalEmbedded`, unlike the
 * read commands (check/search/why) that local mode also serves. So a no-account
 * user who ran `align local start` got an MCP server backed by the cloud default
 * with no token, and their agent's first `align_search` came back 401 - even
 * though the local graph on disk could have answered it.
 *
 * These assert which graph the server is actually backed by, which is the thing
 * the agent experiences, rather than which flags resolveEnv was handed.
 */

const LOCAL: EnvironmentConfig = {
  gatewayUrl: 'http://localhost:8080',
  authToken: null,
  tenantId: null,
  mode: 'local-embedded',
  localDbPath: '/tmp/local.db',
};
const CLOUD_ANON: EnvironmentConfig = {
  gatewayUrl: 'https://api.align.tech',
  authToken: null,
  tenantId: null,
  mode: 'auth',
};
const CLOUD_AUTHED: EnvironmentConfig = {
  gatewayUrl: 'https://api.align.tech',
  authToken: 'tok_real',
  tenantId: 't1',
  mode: 'auth',
};

/** Config state: what `align local start` leaves behind, plus the cloud default. */
let cloudEnv: EnvironmentConfig = CLOUD_ANON;

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn(() => ({
    getDefaultEnv: vi.fn(() => 'prod'),
    getEnvironment: vi.fn((name: string) => (name === 'local' ? LOCAL : cloudEnv)),
  })),
}));
vi.mock('../lib/gateway-client.js', () => ({ createGatewayClient: vi.fn(() => ({})) }));
vi.mock('../lib/mcp-setup.js', () => ({ detectEditors: vi.fn(() => []), writeMcpConfig: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn(() => ({ setRequestHandler: vi.fn(), connect: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: vi.fn(() => ({})) }));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(), outro: vi.fn(), note: vi.fn(), cancel: vi.fn(),
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() },
}));

const { registerMcpCommand } = await import('../commands/mcp.js');
const { createGatewayClient } = await import('../lib/gateway-client.js');

async function runMcp(argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerMcpCommand(program);
  await program.parseAsync(argv, { from: 'user' });
}

/** The environment config the MCP server's gateway client was built from. */
function backingEnv(): EnvironmentConfig {
  const calls = vi.mocked(createGatewayClient).mock.calls;
  if (!calls.length) throw new Error('createGatewayClient was never called');
  return calls[calls.length - 1]![0] as EnvironmentConfig;
}

describe('align mcp environment routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloudEnv = CLOUD_ANON;
    delete process.env['ALIGN_ENV'];
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  it('backs the server with the local graph for a no-account local-embedded user', async () => {
    await runMcp(['mcp']);
    expect(backingEnv().mode).toBe('local-embedded');
  });

  // Second example for the same rule, from the agent's side: the server must be
  // backed by the on-disk graph, not by an anonymous cloud gateway that 401s.
  // (A null authToken is correct here - local mode has no token - so asserting
  // on the token would be wrong; the db path is what proves it reads locally.)
  it('backs the server with the on-disk graph, not the anonymous cloud gateway', async () => {
    await runMcp(['mcp']);
    expect(backingEnv().localDbPath).toBe('/tmp/local.db');
    expect(backingEnv().gatewayUrl).not.toBe('https://api.align.tech');
  });

  // Control: a logged-in user must never be hijacked onto their local graph.
  it('keeps a logged-in user on the cloud even when local-embedded exists', async () => {
    cloudEnv = CLOUD_AUTHED;
    await runMcp(['mcp']);
    expect(backingEnv().mode).toBe('auth');
    expect(backingEnv().authToken).toBe('tok_real');
  });

  // Control: an explicit --env still wins, so the redirect is a fallback, not an override.
  it('honours an explicit --env prod over the local redirect', async () => {
    await runMcp(['mcp', '--env', 'prod']);
    expect(backingEnv().mode).toBe('auth');
  });
});
