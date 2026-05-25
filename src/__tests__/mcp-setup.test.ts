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

  it('returns empty array when no editors found', () => {
    mockExistsSync.mockReturnValue(false);
    expect(detectEditors()).toHaveLength(0);
  });
});

describe('writeMcpConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('merges align server into existing config without overwriting other keys', () => {
    const existing = JSON.stringify({ mcpServers: { other: { command: 'other' } } });
    mockReadFileSync.mockReturnValue(existing);
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockReturnValue(undefined);

    const target: EditorTarget = {
      name: 'Claude Desktop',
      configPath: '/tmp/test-config.json',
      configKey: 'mcpServers',
    };
    writeMcpConfig(target);

    const written = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string,
    ) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers['other']).toBeDefined();
    expect(written.mcpServers['align']).toEqual({ command: 'align', args: ['mcp'] });
  });

  it('creates config from scratch when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      throw err;
    });
    mockMkdirSync.mockReturnValue(undefined);

    const target: EditorTarget = {
      name: 'Cursor',
      configPath: '/tmp/cursor/mcp.json',
      configKey: 'mcpServers',
    };
    writeMcpConfig(target);

    expect(mockWriteFileSync).toHaveBeenCalled();
    const written = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string,
    ) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers['align']).toBeDefined();
  });

  it('throws when config file contains invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json{{{');
    mockMkdirSync.mockReturnValue(undefined);

    const target: EditorTarget = {
      name: 'Claude Desktop',
      configPath: '/tmp/test-config.json',
      configKey: 'mcpServers',
    };
    expect(() => writeMcpConfig(target)).toThrow('invalid JSON');
  });

  it('overwrites existing align entry without duplicating', () => {
    const existing = JSON.stringify({
      mcpServers: { align: { command: 'old-align', args: [] } },
    });
    mockReadFileSync.mockReturnValue(existing);
    mockExistsSync.mockReturnValue(true);
    mockMkdirSync.mockReturnValue(undefined);

    const target: EditorTarget = {
      name: 'Claude Desktop',
      configPath: '/tmp/test-config.json',
      configKey: 'mcpServers',
    };
    writeMcpConfig(target);

    const written = JSON.parse(
      mockWriteFileSync.mock.calls[0][1] as string,
    ) as { mcpServers: Record<string, unknown> };
    const keys = Object.keys(written.mcpServers);
    expect(keys.filter(k => k === 'align')).toHaveLength(1);
    expect((written.mcpServers['align'] as { command: string }).command).toBe('align');
  });
});
