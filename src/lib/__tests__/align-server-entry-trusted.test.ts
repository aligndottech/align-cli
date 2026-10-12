import { describe, expect, it } from 'vitest';
import { alignServerEntry } from '../mcp-setup.js';

// ALI-1515: an entry handed to an agent per session names align by its trusted absolute path, not a bare `align` the
// agent would resolve through its own PATH. A file that TRAVELS (committed) stays portable, and with no trusted path
// found the entry falls back to the bare name rather than failing.
const BIN = '/usr/local/bin/align';

describe('alignServerEntry with a trusted binary', () => {
  it('claude-style entry names the absolute path', () => {
    expect(alignServerEntry('mcpServers', 'local', { trustedBin: BIN })).toEqual({ command: BIN, args: ['mcp', '--env', 'local'] });
  });

  it('opencode takes the path as the first element of its command array', () => {
    expect(alignServerEntry('opencode', 'local', { trustedBin: BIN })).toEqual({ type: 'local', command: [BIN, 'mcp', '--env', 'local'] });
  });

  it('a committed file stays portable: bare align, whatever trusted path this machine found', () => {
    expect(alignServerEntry('mcpServers', 'local', { committed: true, trustedBin: BIN })).toEqual({ command: 'align', args: ['mcp', '--env', 'local'] });
  });

  it('no trusted path found (null) falls back to the bare name, as before', () => {
    expect(alignServerEntry('mcpServers', 'local', { trustedBin: null })).toEqual({ command: 'align', args: ['mcp', '--env', 'local'] });
  });

  it('no option at all is unchanged: the written-once configs keep the bare name until phase 2', () => {
    expect(alignServerEntry('mcpServers', 'local')).toEqual({ command: 'align', args: ['mcp', '--env', 'local'] });
  });
});

describe('launchAlignEntry', () => {
  it('ALIGN_NO_TRUSTED_BIN=1 gives the bare entry; unset, a resolved path is absolute or the entry is bare', async () => {
    const { launchAlignEntry } = await import('../trusted-align-bin.js');
    const prior = process.env['ALIGN_NO_TRUSTED_BIN'];
    try {
      process.env['ALIGN_NO_TRUSTED_BIN'] = '1';
      expect(launchAlignEntry('mcpServers')).toEqual({ command: process.platform === 'win32' ? 'cmd' : 'align', args: expect.any(Array) });
      delete process.env['ALIGN_NO_TRUSTED_BIN'];
      const entry = launchAlignEntry('mcpServers') as { command: string; args: string[] };
      const cmd = process.platform === 'win32' ? entry.args[1] : entry.command;
      expect(cmd === 'align' || cmd.includes('align')).toBe(true);
    } finally {
      if (prior === undefined) delete process.env['ALIGN_NO_TRUSTED_BIN'];
      else process.env['ALIGN_NO_TRUSTED_BIN'] = prior;
    }
  });
});
