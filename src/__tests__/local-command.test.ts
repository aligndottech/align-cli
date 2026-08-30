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
    await initLocalMode();
    expect(mockSetLocalMode).toHaveBeenCalledWith(expect.stringMatching(/\.db$/));
  });

  it('does not flip the global default env (would hijack non-MCP commands to a local client that lacks their methods)', async () => {
    await initLocalMode();
    expect(mockSetDefaultEnv).not.toHaveBeenCalled();
  });

  /**
   * These two used to assert the opposite: that initLocalMode writes every detected editor's
   * MCP config when `quiet` is false. It did, silently, from a function whose name says it
   * initialises a graph - and ~/.claude.json and a Claude Desktop config are user-level files
   * people curate across every project.
   *
   * That write moved to connectDetectedAgents, which asks first (ALI-776). Pinned here so it
   * cannot drift back into a function nobody would think to check for it.
   */
  it('does not touch any global editor config', async () => {
    // No detected-editor fixture on purpose: initLocalMode no longer calls detectEditors at
    // all, so staging one would suggest this exercises a path it does not. Asserting BOTH
    // collaborators are untouched is the stronger claim anyway - it catches the write coming
    // back by either route.
    mockDetectEditors.mockClear();
    mockWriteMcpConfig.mockClear();
    await initLocalMode();
    expect(mockDetectEditors).not.toHaveBeenCalled();
    expect(mockWriteMcpConfig).not.toHaveBeenCalled();
  });
});
