import { describe, expect, it, vi } from 'vitest';

const { mockSetLocalMode, mockSetDefaultEnv, mockDetectEditors, mockWriteMcpConfig } = vi.hoisted(() => ({
  mockSetLocalMode: vi.fn(),
  mockSetDefaultEnv: vi.fn(),
  mockDetectEditors: vi.fn().mockReturnValue([]),
  mockWriteMcpConfig: vi.fn(),
}));

vi.mock('../lib/config.js', () => ({
  createConfigStore: vi.fn().mockReturnValue({
    setLocalMode: mockSetLocalMode,
    setDefaultEnv: mockSetDefaultEnv,
    getEnvironment: vi.fn().mockReturnValue({ mode: 'local-embedded', localDbPath: '/tmp/test.db' }),
  }),
}));

vi.mock('../lib/local-db.js', () => ({
  createLocalDb: vi.fn().mockReturnValue({ getStats: vi.fn().mockReturnValue({ decisions: 0, embeddings: 0, conflicts: 0 }), close: vi.fn() }),
}));

vi.mock('../lib/mcp-setup.js', () => ({
  detectEditors: mockDetectEditors,
  writeMcpConfig: mockWriteMcpConfig,
}));

import { initLocalMode } from '../lib/local-mode.js';

describe('initLocalMode', () => {
  it('calls setLocalMode with a path ending in .db', async () => {
    await initLocalMode({ quiet: true });
    expect(mockSetLocalMode).toHaveBeenCalledWith(expect.stringMatching(/\.db$/));
  });

  it('does not flip the global default env (would hijack non-MCP commands to a local client that lacks their methods)', async () => {
    await initLocalMode({ quiet: true });
    expect(mockSetDefaultEnv).not.toHaveBeenCalled();
  });

  it('writes MCP configs for each detected editor when not quiet', async () => {
    const fakeTarget = { name: 'Cursor', configPath: '/tmp/cursor/mcp.json', configKey: 'mcpServers' };
    mockDetectEditors.mockReturnValueOnce([fakeTarget]);
    await initLocalMode({ quiet: false });
    expect(mockWriteMcpConfig).toHaveBeenCalledWith(fakeTarget, 'local');
  });

  it('skips MCP config writing when quiet=true', async () => {
    mockWriteMcpConfig.mockClear();
    await initLocalMode({ quiet: true });
    expect(mockWriteMcpConfig).not.toHaveBeenCalled();
  });
});
