import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type EditorTarget, detectEditors, writeMcpConfig } from '../lib/mcp-setup.js'; // eslint-disable-line sort-imports

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;

function lastWritten(): string {
  return mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1][1] as string;
}

describe('detectEditors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns Claude Desktop when its config dir exists', () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && (p.includes('Claude') || p.includes('.claude')),
    );
    const editors = detectEditors();
    expect(editors.some(e => e.name === 'Claude Desktop')).toBe(true);
  });

  it('returns Cursor when ~/.cursor exists', () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.includes('.cursor'),
    );
    const editors = detectEditors();
    expect(editors.some(e => e.name === 'Cursor')).toBe(true);
  });

  it('returns Claude Code when ~/.claude.json exists', () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('.claude.json'),
    );
    const editors = detectEditors();
    expect(editors.some(e => e.name === 'Claude Code')).toBe(true);
  });

  // Agent-agnostic: any MCP-capable client should be a first-class setup target.
  it('returns Windsurf with the mcpServers format when ~/.codeium/windsurf exists', () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.includes('.codeium'),
    );
    const target = detectEditors().find(e => e.name === 'Windsurf');
    expect(target).toBeDefined();
    expect(target!.format).toBe('mcpServers');
    expect(target!.configPath).toContain('mcp_config.json');
  });

  it('returns Gemini CLI with the mcpServers format when ~/.gemini exists', () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.includes('.gemini'),
    );
    const target = detectEditors().find(e => e.name === 'Gemini CLI');
    expect(target).toBeDefined();
    expect(target!.format).toBe('mcpServers');
  });

  it('returns VS Code with the vscode format when its User dir exists', () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.includes(`Code${'/'}User`),
    );
    const target = detectEditors().find(e => e.name === 'VS Code');
    expect(target).toBeDefined();
    expect(target!.format).toBe('vscode');
    expect(target!.configPath).toContain('mcp.json');
  });

  it('returns Zed with the zed format when ~/.config/zed exists', () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.includes(`${'/'}zed`),
    );
    const target = detectEditors().find(e => e.name === 'Zed');
    expect(target).toBeDefined();
    expect(target!.format).toBe('zed');
    expect(target!.configPath).toContain('settings.json');
  });

  it('returns Codex with the codex format when ~/.codex exists', () => {
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.includes('.codex'),
    );
    const target = detectEditors().find(e => e.name === 'Codex');
    expect(target).toBeDefined();
    expect(target!.format).toBe('codex');
    expect(target!.configPath).toContain('config.toml');
  });

  it('returns empty array when no editors found', () => {
    mockExistsSync.mockReturnValue(false);
    expect(detectEditors()).toHaveLength(0);
  });
});

describe('writeMcpConfig - mcpServers format (Claude/Cursor/Windsurf/Gemini)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('merges align server into existing config without overwriting other keys', () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: 'other' } } });
    mockReadFileSync.mockReturnValue(existing);
    mockExistsSync.mockReturnValue(true);

    const target: EditorTarget = {
      name: 'Claude Desktop',
      configPath: '/tmp/test-config.json',
      format: 'mcpServers',
    };
    writeMcpConfig(target);

    const written = JSON.parse(lastWritten()) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers['other']).toBeDefined();
    expect(written.mcpServers['align']).toEqual({ command: 'align', args: ['mcp'] });
  });

  it('creates config from scratch when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      throw err;
    });

    const target: EditorTarget = {
      name: 'Cursor',
      configPath: '/tmp/cursor/mcp.json',
      format: 'mcpServers',
    };
    writeMcpConfig(target);

    expect(mockWriteFileSync).toHaveBeenCalled();
    const written = JSON.parse(lastWritten()) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers['align']).toBeDefined();
  });

  it('throws when config file contains invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json{{{');

    const target: EditorTarget = {
      name: 'Claude Desktop',
      configPath: '/tmp/test-config.json',
      format: 'mcpServers',
    };
    expect(() => writeMcpConfig(target)).toThrow('invalid JSON');
  });

  it('overwrites existing align entry without duplicating', () => {
    const existing = JSON.stringify({ mcpServers: { align: { command: 'old-align', args: [] } } });
    mockReadFileSync.mockReturnValue(existing);
    mockExistsSync.mockReturnValue(true);

    const target: EditorTarget = {
      name: 'Claude Desktop',
      configPath: '/tmp/test-config.json',
      format: 'mcpServers',
    };
    writeMcpConfig(target);

    const written = JSON.parse(lastWritten()) as { mcpServers: Record<string, unknown> };
    const keys = Object.keys(written.mcpServers);
    expect(keys.filter(k => k === 'align')).toHaveLength(1);
    expect((written.mcpServers['align'] as { command: string }).command).toBe('align');
  });

  it('encodes a non-prod env into the args', () => {
    mockReadFileSync.mockReturnValue('{}');
    const target: EditorTarget = { name: 'Cursor', configPath: '/tmp/c.json', format: 'mcpServers' };
    writeMcpConfig(target, 'preview');
    const written = JSON.parse(lastWritten()) as { mcpServers: Record<string, { args: string[] }> };
    expect(written.mcpServers['align'].args).toEqual(['mcp', '--env', 'preview']);
  });
});

describe('writeMcpConfig - vscode format', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes under the "servers" key with type:stdio', () => {
    mockReadFileSync.mockReturnValue('{}');
    const target: EditorTarget = { name: 'VS Code', configPath: '/tmp/Code/User/mcp.json', format: 'vscode' };
    writeMcpConfig(target);
    const written = JSON.parse(lastWritten()) as { servers: Record<string, unknown> };
    expect(written.servers['align']).toEqual({ type: 'stdio', command: 'align', args: ['mcp'] });
  });

  it('preserves other servers already configured', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ servers: { other: { type: 'stdio', command: 'x' } } }));
    const target: EditorTarget = { name: 'VS Code', configPath: '/tmp/Code/User/mcp.json', format: 'vscode' };
    writeMcpConfig(target);
    const written = JSON.parse(lastWritten()) as { servers: Record<string, unknown> };
    expect(written.servers['other']).toBeDefined();
    expect(written.servers['align']).toBeDefined();
  });
});

describe('writeMcpConfig - zed format', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes under "context_servers" with the required source:custom', () => {
    mockReadFileSync.mockReturnValue('{}');
    const target: EditorTarget = { name: 'Zed', configPath: '/tmp/zed/settings.json', format: 'zed' };
    writeMcpConfig(target);
    const written = JSON.parse(lastWritten()) as { context_servers: Record<string, unknown> };
    expect(written.context_servers['align']).toEqual({ source: 'custom', command: 'align', args: ['mcp'] });
  });

  it('preserves unrelated Zed settings', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ theme: 'One Dark', context_servers: {} }));
    const target: EditorTarget = { name: 'Zed', configPath: '/tmp/zed/settings.json', format: 'zed' };
    writeMcpConfig(target);
    const written = JSON.parse(lastWritten()) as { theme: string; context_servers: Record<string, unknown> };
    expect(written.theme).toBe('One Dark');
    expect(written.context_servers['align']).toBeDefined();
  });
});

describe('writeMcpConfig - codex (TOML) format', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes an [mcp_servers.align] table when config.toml is absent', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const target: EditorTarget = { name: 'Codex', configPath: '/tmp/.codex/config.toml', format: 'codex' };
    writeMcpConfig(target);
    const written = lastWritten();
    expect(written).toContain('[mcp_servers.align]');
    expect(written).toContain('command = "align"');
    expect(written).toContain('args = ["mcp"]');
  });

  it('encodes a non-prod env into the args array', () => {
    mockReadFileSync.mockReturnValue('');
    const target: EditorTarget = { name: 'Codex', configPath: '/tmp/.codex/config.toml', format: 'codex' };
    writeMcpConfig(target, 'preview');
    expect(lastWritten()).toContain('args = ["mcp", "--env", "preview"]');
  });

  it('preserves an existing unrelated mcp server table', () => {
    mockReadFileSync.mockReturnValue('[mcp_servers.other]\ncommand = "other"\n');
    const target: EditorTarget = { name: 'Codex', configPath: '/tmp/.codex/config.toml', format: 'codex' };
    writeMcpConfig(target);
    const written = lastWritten();
    expect(written).toContain('[mcp_servers.other]');
    expect(written).toContain('[mcp_servers.align]');
  });

  it('is idempotent - re-running replaces the managed block instead of duplicating it', () => {
    const target: EditorTarget = { name: 'Codex', configPath: '/tmp/.codex/config.toml', format: 'codex' };
    mockReadFileSync.mockReturnValue('');
    writeMcpConfig(target);
    const first = lastWritten();
    mockReadFileSync.mockReturnValue(first);
    writeMcpConfig(target);
    const second = lastWritten();
    expect(second.split('[mcp_servers.align]')).toHaveLength(2); // exactly one table
  });
});

// mkdirSync is exercised through the writers; keep a reference so the import is used.
void mockMkdirSync;