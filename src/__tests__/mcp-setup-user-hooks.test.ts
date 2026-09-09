import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import { tmpdir } from 'node:os';

// detectEditors reads os.homedir(); point it at a throwaway home so this machine's real
// agents play no part. Both the default and the named export are replaced, since
// mcp-setup.ts imports the default.
const home = vi.hoisted(() => ({ value: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  const homedir = (): string => home.value;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { alignServerEntry, detectEditors, type EditorTarget, removeMcpConfig, writeMcpConfig } from '../lib/mcp-setup.js';

/**
 * ALI-952: the hosts with a user-level hook file get the advisory hook written NEXT TO their
 * MCP entry, by the same writer setup and `align mcp --setup` already call - so every path
 * that wires an agent wires the hook, and `align mcp --remove` takes both out. No new call
 * site anywhere.
 */
describe('detectEditors attaches the user-level hook file to the hosts that have one', () => {
  beforeEach(() => { home.value = mkdtempSync(join(tmpdir(), 'align-home-')); });
  afterEach(() => { rmSync(home.value, { recursive: true, force: true }); });

  it.each([
    ['Codex', '.codex', 'codex', '.codex/hooks.json'],
    ['Cursor', '.cursor', 'cursor', '.cursor/hooks.json'],
    ['Copilot CLI', '.copilot', 'copilot', '.copilot/hooks/align.json'],
  ])('%s', (name, dir, host, hooksRel) => {
    mkdirSync(join(home.value, dir), { recursive: true });
    const target = detectEditors().find((e) => e.name === name);
    expect(target).toBeDefined();
    expect(target!.hooks).toEqual({ host, path: join(home.value, hooksRel) });
  });

  it('Copilot CLI reads ~/.copilot/mcp-config.json in the copilot format', () => {
    mkdirSync(join(home.value, '.copilot'), { recursive: true });
    const target = detectEditors().find((e) => e.name === 'Copilot CLI');
    expect(target?.configPath).toBe(join(home.value, '.copilot', 'mcp-config.json'));
    expect(target?.format).toBe('copilot');
  });

  it('gives no hook file to a host with no user-level hook API', () => {
    mkdirSync(join(home.value, '.codeium', 'windsurf'), { recursive: true });
    mkdirSync(join(home.value, '.gemini'), { recursive: true });
    for (const name of ['Windsurf', 'Gemini CLI']) {
      const target = detectEditors().find((e) => e.name === name);
      expect(target, name).toBeDefined();
      expect(target!.hooks).toBeUndefined();
    }
  });
});

describe('alignServerEntry - copilot format', () => {
  // Copilot CLI's mcp-config.json needs type and a tools allowlist, or the server's tools
  // are configured and never callable (Copilot MCP docs: tools is mandatory).
  it('carries type:local and tools:["*"]', () => {
    expect(alignServerEntry('copilot', 'local')).toEqual({ type: 'local', command: 'align', args: ['mcp', '--env', 'local'], tools: ['*'] });
  });
});

describe('writeMcpConfig / removeMcpConfig with a hook file', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'align-mcp-hooks-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const cursor = (): EditorTarget => ({
    name: 'Cursor', configPath: join(dir, '.cursor', 'mcp.json'), format: 'mcpServers',
    hooks: { host: 'cursor', path: join(dir, '.cursor', 'hooks.json') },
  });
  const copilot = (): EditorTarget => ({
    name: 'Copilot CLI', configPath: join(dir, '.copilot', 'mcp-config.json'), format: 'copilot',
    hooks: { host: 'copilot', path: join(dir, '.copilot', 'hooks', 'align.json') },
  });

  it('writes the MCP entry AND the hook, and reports both files', () => {
    const written = writeMcpConfig(cursor(), 'local');
    expect(written).toEqual([cursor().configPath, cursor().hooks!.path]);
    expect(JSON.parse(readFileSync(cursor().configPath, 'utf8')).mcpServers.align.args).toEqual(['mcp', '--env', 'local']);
    expect(JSON.parse(readFileSync(cursor().hooks!.path, 'utf8')).hooks.preToolUse[0].command).toContain('--env local');
  });

  it('reports only the config file for a host with no hook file', () => {
    const t: EditorTarget = { name: 'Windsurf', configPath: join(dir, 'w.json'), format: 'mcpServers' };
    expect(writeMcpConfig(t)).toEqual([t.configPath]);
  });

  it('writes the copilot mcp-config.json shape', () => {
    writeMcpConfig(copilot());
    expect(JSON.parse(readFileSync(copilot().configPath, 'utf8')).mcpServers.align).toEqual({ type: 'local', command: 'align', args: ['mcp'], tools: ['*'] });
    expect(existsSync(copilot().hooks!.path)).toBe(true);
  });

  it('remove takes out both the entry and the hook', () => {
    writeMcpConfig(cursor());
    expect(removeMcpConfig(cursor())).toBe(true);
    expect(JSON.parse(readFileSync(cursor().configPath, 'utf8')).mcpServers.align).toBeUndefined();
    // The hooks file held only ours, so it is gone rather than left as an empty shell.
    expect(existsSync(cursor().hooks!.path)).toBe(false);
  });

  it('remove still reports true when only the hook was left to remove', () => {
    writeMcpConfig(cursor());
    removeMcpConfig({ ...cursor(), hooks: undefined });   // entry gone, hook still there
    expect(removeMcpConfig(cursor())).toBe(true);
    expect(existsSync(cursor().hooks!.path)).toBe(false);
  });
});
