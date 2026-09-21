import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ALI-1135: what `align mcp --setup` writes has to be a command the client can actually
 * spawn on the platform it was written for.
 *
 * An npm global install on Windows exposes `align.cmd`, a batch shim, and a Windows process
 * spawn resolves a `.cmd` only through a shell - Node's own child_process refuses one outright
 * without `shell: true` (CVE-2024-27980). So `command: "align"` names something the client
 * cannot launch, and the client reports ENOENT against a config Align wrote for it. Our write
 * succeeded, so nothing on this side says anything is wrong.
 *
 * `cmd` is a real executable, so `cmd /c align mcp` launches whether or not the client spawns
 * through a shell of its own. That is the form the MCP ecosystem settled on for exactly this
 * (microsoft/vscode#299595, modelcontextprotocol/servers#3460), and it is already what this
 * repo's own Windows smoke relies on: scripts/smoke-install.sh spawns the bare name through
 * cmd.exe because "cmd resolves `align` -> align.cmd via PATH + PATHEXT".
 *
 * BOTH platforms are set explicitly here. Inheriting the host's would leave the win32 half
 * unrunnable on this repo's Linux and macOS legs while still reporting a pass - a test whose
 * precondition was never established (tdd.md).
 */

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { readFileSync, writeFileSync } from 'node:fs';
import { type Platform, restorePlatform, setPlatform } from './helpers/platform.js';
import { alignServerEntry, type EditorTarget, type McpFormat, writeMcpConfig } from '../lib/mcp-setup.js';

const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>;

afterAll(restorePlatform);

function lastWritten(): string {
  return mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1][1] as string;
}

/** Every JSON format detectEditors can hand the writer. Codex is TOML and is asserted separately. */
const JSON_FORMATS: McpFormat[] = ['mcpServers', 'vscode', 'zed', 'pi', 'copilot'];

function entryOf(format: McpFormat, env?: string): { command: string; args: string[] } {
  const entry = alignServerEntry(format, env) as { command: string; args: string[] };
  return { command: entry.command, args: entry.args };
}

describe('alignServerEntry on Windows (ALI-1135)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('win32');
  });

  it.each(JSON_FORMATS)('emits a spawnable command for the %s format, not the bare align.cmd shim', (format) => {
    const { command, args } = entryOf(format);
    // The defect, named directly: an npm global install puts align.cmd on PATH, and no
    // client that spawns without a shell can launch that.
    expect(command).not.toBe('align');
    // cmd.exe is a real executable, so this launches from any client, shell or no shell.
    expect(command).toBe('cmd');
    // ...and it still has to run OUR server. A spawnable command that invokes something
    // else would satisfy the assertion above and ship a broken config.
    expect(args).toEqual(['/c', 'align', 'mcp']);
  });

  it('keeps the vscode entry otherwise untouched - VS Code still requires type: stdio', () => {
    expect(alignServerEntry('vscode')).toEqual({ type: 'stdio', command: 'cmd', args: ['/c', 'align', 'mcp'] });
  });

  it('keeps the per-format extras that are not about the command', () => {
    expect(alignServerEntry('zed')).toEqual({ source: 'custom', command: 'cmd', args: ['/c', 'align', 'mcp'] });
    expect(alignServerEntry('pi')).toEqual({ command: 'cmd', args: ['/c', 'align', 'mcp'], directTools: true });
    expect(alignServerEntry('copilot')).toEqual({
      type: 'local',
      command: 'cmd',
      args: ['/c', 'align', 'mcp'],
      tools: ['*'],
    });
  });

  it('carries a non-prod env through after the wrapper, not before it', () => {
    expect(entryOf('vscode', 'local')).toEqual({ command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] });
  });

  it('writes the wrapped command all the way through to the VS Code config file', () => {
    mockReadFileSync.mockReturnValue('{}');
    const target: EditorTarget = { name: 'VS Code', configPath: '/tmp/Code/User/mcp.json', format: 'vscode' };
    writeMcpConfig(target);
    const written = JSON.parse(lastWritten()) as { servers: Record<string, { command: string; args: string[] }> };
    expect(written.servers['align'].command).toBe('cmd');
    expect(written.servers['align'].args).toEqual(['/c', 'align', 'mcp']);
  });

  // The Codex TOML block is a SECOND writer of the same fact - it builds its own
  // `command = "align"` line rather than going through alignServerEntry. Fixing only the
  // JSON half is this repo's two-writers shape (code-style.md).
  it('wraps the Codex TOML block too, which builds its command line separately', () => {
    mockReadFileSync.mockReturnValue('');
    const target: EditorTarget = { name: 'Codex', configPath: '/tmp/.codex/config.toml', format: 'codex' };
    writeMcpConfig(target);
    const written = lastWritten();
    expect(written).toContain('command = "cmd"');
    expect(written).toContain('args = ["/c", "align", "mcp"]');
    expect(written).not.toContain('command = "align"');
  });
});

describe('alignServerEntry off Windows (ALI-1135)', () => {
  beforeEach(() => vi.clearAllMocks());

  // Both non-Windows platforms, stated rather than inherited: on POSIX `align` is a real
  // executable with a shebang, so the wrapper would be pure indirection - and `cmd` does
  // not exist there at all.
  it.each(['linux', 'darwin'] as Platform[])('leaves the bare command alone on %s', (platform) => {
    setPlatform(platform);
    for (const format of JSON_FORMATS) {
      expect(entryOf(format)).toEqual({ command: 'align', args: ['mcp'] });
    }
    expect(entryOf('vscode', 'preview')).toEqual({ command: 'align', args: ['mcp', '--env', 'preview'] });
  });

  it('leaves the Codex TOML block alone on linux', () => {
    setPlatform('linux');
    mockReadFileSync.mockReturnValue('');
    const target: EditorTarget = { name: 'Codex', configPath: '/tmp/.codex/config.toml', format: 'codex' };
    writeMcpConfig(target);
    expect(lastWritten()).toContain('command = "align"');
  });
});
