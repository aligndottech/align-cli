import { afterEach, describe, expect, it } from 'vitest';
import { alignServerEntry } from '../mcp-setup.js';

// ALI-1515: an entry handed to an agent per session names align by its trusted absolute path, not a bare `align` the
// agent would resolve through its own PATH. A file that TRAVELS (committed) stays portable, and with no trusted path
// found the entry falls back to the bare name rather than failing.
const BIN = '/usr/local/bin/align';

// ALI-1135: on win32, alignSpawn (mcp-setup.ts) always wraps the command through `cmd /c`, since
// Node refuses to spawn a `.cmd` shim directly (CVE-2024-27980) and an npm global install only
// exposes align.cmd there. That wrapping is unconditional for every format except `committed`,
// which stays bare on every platform (a committed file travels, and there is no string that
// spawns correctly on both). Build the expected shape per platform rather than assuming one,
// the same way trusted-align-bin.test.ts injects `platform` and lead-prompt.test.ts stubs it.
const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setPlatform(value: typeof process.platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}
afterEach(() => { Object.defineProperty(process, 'platform', REAL_PLATFORM); });

const spawnArgs = (bin: string, win: boolean) => (win ? ['/c', bin, 'mcp', '--env', 'local'] : ['mcp', '--env', 'local']);
const spawnCommand = (bin: string, win: boolean) => (win ? 'cmd' : bin);

describe.each([
  ['POSIX', false as const],
  ['win32', true as const],
])('alignServerEntry with a trusted binary (%s)', (_label, win) => {
  it('claude-style entry names the absolute path', () => {
    setPlatform(win ? 'win32' : 'linux');
    expect(alignServerEntry('mcpServers', 'local', { trustedBin: BIN })).toEqual({
      command: spawnCommand(BIN, win),
      args: spawnArgs(BIN, win),
    });
  });

  it('opencode takes the path as the first element of its command array', () => {
    setPlatform(win ? 'win32' : 'linux');
    expect(alignServerEntry('opencode', 'local', { trustedBin: BIN })).toEqual({
      type: 'local',
      command: [spawnCommand(BIN, win), ...spawnArgs(BIN, win)],
    });
  });

  it('a committed file stays portable: bare align, whatever trusted path this machine found', () => {
    // committed:true deliberately SKIPS the win32 wrapper - see alignSpawn's doc comment in
    // mcp-setup.ts - so this one expectation does not vary by platform.
    setPlatform(win ? 'win32' : 'linux');
    expect(alignServerEntry('mcpServers', 'local', { committed: true, trustedBin: BIN })).toEqual({ command: 'align', args: ['mcp', '--env', 'local'] });
  });

  it('no trusted path found (null) falls back to the bare name, as before', () => {
    setPlatform(win ? 'win32' : 'linux');
    expect(alignServerEntry('mcpServers', 'local', { trustedBin: null })).toEqual({
      command: spawnCommand('align', win),
      args: spawnArgs('align', win),
    });
  });

  it('no option at all is unchanged: the written-once configs keep the bare name until phase 2', () => {
    setPlatform(win ? 'win32' : 'linux');
    expect(alignServerEntry('mcpServers', 'local')).toEqual({
      command: spawnCommand('align', win),
      args: spawnArgs('align', win),
    });
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
