/**
 * The non-local guard is OPT-IN: only a caller that passes `onForeign` (the wizard's local
 * wiring) leaves a team entry alone. An explicit `align mcp --setup --env local` is how docs
 * and the setup hints tell a user to SWITCH to the local graph, so it must overwrite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import type * as McpSetup from '../lib/mcp-setup.js';
import { type EditorTarget, writeMcpConfig } from '../lib/mcp-setup.js';
import { setupAgentAlignment } from '../lib/agent-rules.js';
import { writeUserHooks } from '../lib/user-hooks.js';

const detect = vi.hoisted(() => ({ editors: [] as unknown[] }));
vi.mock('../lib/mcp-setup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof McpSetup>()),
  detectEditors: () => detect.editors,
}));
const stops = vi.hoisted(() => [] as string[]);
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: (m: string) => stops.push(m) }),
  multiselect: vi.fn(async () => ['Claude Code']),
  isCancel: () => false,
  cancel: vi.fn(),
}));

import { registerMcpCommand } from '../commands/mcp.js';
import { alignEntryArgv, alignEntryShape } from './helpers/platform.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'align-optin-')); stops.length = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const PROD = { command: 'align', args: ['mcp'] };
const target = (file: string, format: EditorTarget['format'] = 'mcpServers'): EditorTarget =>
  ({ name: 'Claude Code', configPath: file, format });
const servers = (file: string, key = 'mcpServers') => JSON.parse(readFileSync(file, 'utf8'))[key];

describe('writeMcpConfig without onForeign overwrites, as before', () => {
  it('replaces a prod entry with the local one', () => {
    const file = path.join(dir, '.claude.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { align: PROD } }));
    expect(writeMcpConfig(target(file), 'local')).toEqual([file]);
    expect(servers(file).align.args).toEqual(alignEntryShape(['mcp', '--env', 'local']).args);
  });
  it('replaces a hand-written Codex table', () => {
    const file = path.join(dir, 'config.toml');
    writeFileSync(file, '[mcp_servers.align]\ncommand = "align"\nargs = ["mcp"]\n');
    writeMcpConfig(target(file, 'codex'), 'local');
    expect(readFileSync(file, 'utf8')).toContain('"--env", "local"');
  });
  it('replaces an OpenCode prod command array', () => {
    const file = path.join(dir, 'opencode.json');
    writeFileSync(file, JSON.stringify({ mcp: { align: { type: 'local', command: ['align', 'mcp'] } } }));
    writeMcpConfig(target(file, 'opencode'), 'local');
    expect(servers(file, 'mcp').align.command).toEqual(alignEntryArgv(['mcp', '--env', 'local']));
  });
  it('replaces a prod user hook', () => {
    const hookFile = path.join(dir, 'hooks.json');
    const t = { ...target(path.join(dir, 'cursor.json')), hooks: { host: 'cursor' as const, path: hookFile } };
    writeUserHooks(t.hooks, undefined);
    expect(writeMcpConfig(t, 'local')).toEqual([t.configPath, hookFile]);
    expect(readFileSync(hookFile, 'utf8')).toContain('--env local');
  });
  it('setupAgentAlignment without onForeign rewrites a prod .mcp.json', () => {
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { align: PROD } }));
    const written = setupAgentAlignment({ cwd: dir, env: 'local' });
    expect(written).toContain('.mcp.json');
    expect(servers(path.join(dir, '.mcp.json')).align.args).toEqual(['mcp', '--env', 'local']);
  });
});

describe('`align mcp --setup --env local`', () => {
  it('overwrites an existing prod entry and says it replaced one', async () => {
    const file = path.join(dir, '.claude.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { align: PROD } }));
    detect.editors = [target(file)];
    const program = new Command();
    program.exitOverride();
    registerMcpCommand(program);
    await program.parseAsync(['node', 'align', 'mcp', '--setup', '--env', 'local']);
    expect(servers(file).align.args).toEqual(alignEntryShape(['mcp', '--env', 'local']).args);
    const said = stops.join('\n');
    expect(said).toContain('align added');
    expect(said).toMatch(/replaced the existing align entry/);
  });
  it('does not claim a replacement when there was no entry', async () => {
    const file = path.join(dir, '.claude.json');
    mkdirSync(dir, { recursive: true });
    detect.editors = [target(file)];
    const program = new Command();
    program.exitOverride();
    registerMcpCommand(program);
    await program.parseAsync(['node', 'align', 'mcp', '--setup', '--env', 'local']);
    expect(existsSync(file)).toBe(true);
    expect(stops.join('\n')).not.toMatch(/replaced/);
  });
});
