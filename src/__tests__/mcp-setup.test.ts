import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import path from 'node:path';
import { type EditorTarget, detectEditors, detectWiredEditors, projectMcpAgents, writeMcpConfig } from '../lib/mcp-setup.js'; // eslint-disable-line sort-imports

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
    // Normalize separators so the matcher works under Windows path.join (backslashes).
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.replace(/\\/g, '/').includes('Code/User'),
    );
    const target = detectEditors().find(e => e.name === 'VS Code');
    expect(target).toBeDefined();
    expect(target!.format).toBe('vscode');
    expect(target!.configPath).toContain('mcp.json');
  });

  it('returns Zed with the zed format when ~/.config/zed exists', () => {
    // Normalize separators so the matcher works under Windows path.join (backslashes).
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.replace(/\\/g, '/').includes('/zed'),
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

// pi (https://pi.dev) reads MCP config from its agent dir, which the pi-mcp-adapter
// relocates via $PI_CODING_AGENT_DIR. Both sides of that conditional are set
// explicitly here - inheriting the ambient value would make one of these vacuous.
describe('detectEditors - pi', () => {
  const savedAgentDir = process.env['PI_CODING_AGENT_DIR'];

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = savedAgentDir;
  });

  it('returns pi with the pi format when ~/.pi exists', () => {
    delete process.env['PI_CODING_AGENT_DIR'];
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.replace(/\\/g, '/').endsWith('/.pi'),
    );
    const target = detectEditors().find(e => e.name === 'pi');
    expect(target).toBeDefined();
    expect(target!.format).toBe('pi');
    expect(target!.configPath.replace(/\\/g, '/')).toMatch(/\/\.pi\/agent\/mcp\.json$/);
  });

  it('honours $PI_CODING_AGENT_DIR even when ~/.pi does not exist', () => {
    process.env['PI_CODING_AGENT_DIR'] = '/custom/pi-agent';
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.replace(/\\/g, '/') === '/custom/pi-agent',
    );
    const target = detectEditors().find(e => e.name === 'pi');
    expect(target).toBeDefined();
    expect(target!.configPath.replace(/\\/g, '/')).toBe('/custom/pi-agent/mcp.json');
  });

  it('does not return pi when neither the agent dir nor ~/.pi exists', () => {
    delete process.env['PI_CODING_AGENT_DIR'];
    mockExistsSync.mockReturnValue(false);
    expect(detectEditors().some(e => e.name === 'pi')).toBe(false);
  });
});

describe('writeMcpConfig - pi format', () => {
  beforeEach(() => vi.clearAllMocks());

  // directTools is what keeps align's tools in the model's context. Without it the
  // adapter hides every server behind one proxy tool the agent must search first,
  // which defeats "call align_check_alignment BEFORE writing code".
  it('writes under "mcpServers" with directTools so the tools stay directly callable', () => {
    mockReadFileSync.mockReturnValue('{}');
    const target: EditorTarget = { name: 'pi', configPath: '/tmp/.pi/agent/mcp.json', format: 'pi' };
    writeMcpConfig(target);
    const written = JSON.parse(lastWritten()) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers['align']).toEqual({ command: 'align', args: ['mcp'], directTools: true });
  });

  it('keeps directTools when a non-prod env is encoded into the args', () => {
    mockReadFileSync.mockReturnValue('{}');
    const target: EditorTarget = { name: 'pi', configPath: '/tmp/.pi/agent/mcp.json', format: 'pi' };
    writeMcpConfig(target, 'local');
    const written = JSON.parse(lastWritten()) as { mcpServers: Record<string, { args: string[]; directTools: boolean }> };
    expect(written.mcpServers['align'].args).toEqual(['mcp', '--env', 'local']);
    expect(written.mcpServers['align'].directTools).toBe(true);
  });

  it('preserves other servers already in the pi agent config', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const target: EditorTarget = { name: 'pi', configPath: '/tmp/.pi/agent/mcp.json', format: 'pi' };
    writeMcpConfig(target);
    const written = JSON.parse(lastWritten()) as { mcpServers: Record<string, unknown> };
    expect(written.mcpServers['other']).toBeDefined();
    expect(written.mcpServers['align']).toBeDefined();
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
/**
 * ALI-950: the second-run card names the agents that are wired NOW, which is a different
 * question from detectEditors' "which agents are installed". An installed agent whose
 * config never got an align entry (setup failed on it, or `align mcp --remove` ran) is
 * not connected, and naming it on the card would tell someone to open an agent that
 * cannot answer.
 */
describe('detectWiredEditors (ALI-950)', () => {
  beforeEach(() => vi.clearAllMocks());

  const enoent = (): never => {
    const e = new Error('ENOENT') as Error & { code: string };
    e.code = 'ENOENT';
    throw e;
  };
  const cursorAndCodexInstalled = (p: unknown): boolean =>
    typeof p === 'string' && (p.includes('.cursor') || p.includes('.codex'));

  it('keeps only the detected agents whose config already carries an align entry', () => {
    mockExistsSync.mockImplementation(cursorAndCodexInstalled);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).includes('.cursor')) return JSON.stringify({ mcpServers: { align: { command: 'align', args: ['mcp'] } } });
      if (String(p).includes('.codex')) return '[mcp_servers.other]\ncommand = "other"\n';
      return enoent();
    });
    expect(detectWiredEditors().map((e) => e.name)).toEqual(['Cursor']);
  });

  it('reads the Codex TOML marker block, since that format has no JSON key to look for', () => {
    mockExistsSync.mockImplementation(cursorAndCodexInstalled);
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).includes('.cursor')) return JSON.stringify({ mcpServers: { other: {} } });
      if (String(p).includes('.codex')) return '# >>> align (managed by `align setup` - do not edit) >>>\n[mcp_servers.align]\ncommand = "align"\nargs = ["mcp"]\n# <<< align <<<\n';
      return enoent();
    });
    expect(detectWiredEditors().map((e) => e.name)).toEqual(['Codex']);
  });

  it('treats a missing, empty or unparseable config as not wired, and never throws', () => {
    mockExistsSync.mockImplementation(cursorAndCodexInstalled);
    mockReadFileSync.mockImplementation((p: unknown) => (String(p).includes('.codex') ? '{not json' : enoent()));
    expect(detectWiredEditors()).toEqual([]);
  });
});

describe('projectMcpAgents (ALI-950)', () => {
  beforeEach(() => vi.clearAllMocks());

  const enoent = (): never => {
    const e = new Error('ENOENT') as Error & { code: string };
    e.code = 'ENOENT';
    throw e;
  };
  const projectFile = path.join('/repo', '.mcp.json');

  it("names Claude Code when this repo's .mcp.json carries an align server", () => {
    mockReadFileSync.mockImplementation((p: unknown) =>
      String(p) === projectFile ? JSON.stringify({ mcpServers: { align: { command: 'align', args: ['mcp'] } } }) : enoent());
    expect(projectMcpAgents('/repo')).toEqual(['Claude Code']);
  });

  it('names nobody when the file is absent, or carries no align entry', () => {
    mockReadFileSync.mockImplementation(enoent);
    expect(projectMcpAgents('/repo')).toEqual([]);
    mockReadFileSync.mockImplementation(() => JSON.stringify({ mcpServers: { other: {} } }));
    expect(projectMcpAgents('/repo')).toEqual([]);
  });

  it('names nobody, and does not throw, on a file it cannot parse - the card must never error', () => {
    mockReadFileSync.mockImplementation(() => '{not json');
    expect(projectMcpAgents('/repo')).toEqual([]);
  });
});
