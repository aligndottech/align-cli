import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EditorTarget, writeMcpConfig } from '../lib/mcp-setup.js';
import { BACKUP_SUFFIX } from '../lib/safe-config-write.js';
import { pinPlatform } from './helpers/platform.js';

/*
 * C4 Test List (the Cursor and Codex global writes go through the safe writer):
 *  1. Cursor mcp.json: original kept in .align-backup, other servers kept, second write keeps the FIRST backup
 *  2. Codex config.toml: same two
 *  3. Cursor hooks.json: original kept in .align-backup
 *  4. a symlinked Cursor/Codex config is refused with one stderr line and the link target is untouched
 *  5. C5's opt-in guard is unchanged: the wizard (onForeign) leaves a team entry alone and writes no backup;
 *     explicit `mcp --setup` (no onForeign) overwrites it, with a backup
 *  6. scope: Windsurf (a JSON config outside C4) and Copilot's hook file are NOT given a backup
 */
pinPlatform('linux');

let dir: string;
let errors: string[];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'align-mcp-safe-'));
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((l: unknown) => { errors.push(String(l)); });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const cursor = (): EditorTarget => ({
  name: 'Cursor',
  configPath: path.join(dir, '.cursor', 'mcp.json'),
  format: 'mcpServers',
  hooks: { host: 'cursor', path: path.join(dir, '.cursor', 'hooks.json') },
});
const codex = (): EditorTarget => ({ name: 'Codex', configPath: path.join(dir, '.codex', 'config.toml'), format: 'codex' });
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const teamEntry = JSON.stringify({ mcpServers: { align: { command: 'align', args: ['mcp'] } } }, null, 2);

describe('Cursor global config', () => {
  it('backs up mcp.json once and keeps the other servers', () => {
    const t = cursor();
    const original = '{ "mcpServers": { "other": { "command": "x" } } }\n';
    put(t.configPath, original);
    writeMcpConfig(t, 'local');
    writeMcpConfig(t, 'staging');
    expect(readFileSync(t.configPath + BACKUP_SUFFIX, 'utf8')).toBe(original);
    const now = JSON.parse(readFileSync(t.configPath, 'utf8')).mcpServers;
    expect(Object.keys(now).sort()).toEqual(['align', 'other']);
    expect(now.align.args).toEqual(['mcp', '--env', 'staging']);
  });

  it('backs up hooks.json too, and leaves the user\'s own hook in it', () => {
    const t = cursor();
    const original = JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'mine', matcher: 'Write' }] } });
    put(t.hooks!.path, original);
    expect(writeMcpConfig(t, 'local')).toContain(t.hooks!.path);
    expect(readFileSync(t.hooks!.path + BACKUP_SUFFIX, 'utf8')).toBe(original);
    expect(readFileSync(t.hooks!.path, 'utf8')).toContain('"mine"');
  });

  it('refuses a symlinked mcp.json: one line, nothing written, target untouched', () => {
    const t = cursor();
    const real = path.join(dir, 'other-tool.json');
    put(real, '{"theirs":1}');
    mkdirSync(path.dirname(t.configPath), { recursive: true });
    symlinkSync(real, t.configPath);
    const written = writeMcpConfig({ ...t, hooks: undefined }, 'local');
    expect(written).toEqual([]);
    expect(readFileSync(real, 'utf8')).toBe('{"theirs":1}');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(t.configPath);
    expect(errors[0]).toContain(real);
  });
});

describe('Codex config', () => {
  it('backs up config.toml once and keeps the user\'s settings', () => {
    const t = codex();
    const original = 'model = "gpt-5"\n[mcp_servers.linear]\ncommand = "l"\n';
    put(t.configPath, original);
    writeMcpConfig(t, 'local');
    writeMcpConfig(t, 'local');
    expect(readFileSync(t.configPath + BACKUP_SUFFIX, 'utf8')).toBe(original);
    const text = readFileSync(t.configPath, 'utf8');
    expect(text).toContain('model = "gpt-5"');
    expect(text.match(/\[mcp_servers\.align\]/g)).toHaveLength(1);
  });

  it('refuses a symlinked config.toml', () => {
    const t = codex();
    const real = path.join(dir, 'real.toml');
    put(real, 'a = 1\n');
    mkdirSync(path.dirname(t.configPath), { recursive: true });
    symlinkSync(real, t.configPath);
    expect(writeMcpConfig(t, 'local')).toEqual([]);
    expect(readFileSync(real, 'utf8')).toBe('a = 1\n');
    expect(errors.join('\n')).toContain(real);
  });
});

describe('the wizard guard is unchanged (C5)', () => {
  it('Cursor: onForeign leaves a team align entry alone, no backup; no onForeign overwrites it, with a backup', () => {
    const t = { ...cursor(), hooks: undefined };
    put(t.configPath, teamEntry);
    const foreign = vi.fn();
    expect(writeMcpConfig(t, 'local', foreign)).toEqual([]);
    expect(foreign).toHaveBeenCalledExactlyOnceWith(t.configPath);
    expect(readFileSync(t.configPath, 'utf8')).toBe(teamEntry);
    expect(() => readFileSync(t.configPath + BACKUP_SUFFIX)).toThrow();
    expect(writeMcpConfig(t, 'local')).toEqual([t.configPath]);
    expect(readFileSync(t.configPath + BACKUP_SUFFIX, 'utf8')).toBe(teamEntry);
    expect(readFileSync(t.configPath, 'utf8')).toContain('"local"');
  });

  it('Codex: onForeign leaves a hand-written align table alone; no onForeign overwrites it', () => {
    const t = codex();
    const handWritten = '[mcp_servers.align]\ncommand = "align"\nargs = ["mcp"]\n';
    put(t.configPath, handWritten);
    const foreign = vi.fn();
    expect(writeMcpConfig(t, 'local', foreign)).toEqual([]);
    expect(foreign).toHaveBeenCalledOnce();
    expect(readFileSync(t.configPath, 'utf8')).toBe(handWritten);
    expect(writeMcpConfig(t, 'local')).toEqual([t.configPath]);
    expect(readFileSync(t.configPath, 'utf8')).toContain('--env');
  });

  it('Cursor hooks: a team hook is left alone for the wizard, backed up and replaced otherwise', () => {
    const t = cursor();
    const team = JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'align check --advisory --format cursor', matcher: 'Write' }] } });
    put(t.hooks!.path, team);
    const foreign = vi.fn();
    writeMcpConfig({ ...t, configPath: path.join(dir, 'unused.json') }, 'local', foreign);
    expect(foreign).toHaveBeenCalledWith(t.hooks!.path);
    expect(readFileSync(t.hooks!.path, 'utf8')).toBe(team);
    writeMcpConfig(t, 'local');
    expect(readFileSync(t.hooks!.path + BACKUP_SUFFIX, 'utf8')).toBe(team);
  });
});

describe('scope', () => {
  it('Windsurf and Copilot\'s hook file are still written by their own writers: no backup', () => {
    const windsurf: EditorTarget = { name: 'Windsurf', configPath: path.join(dir, 'w', 'mcp_config.json'), format: 'mcpServers' };
    put(windsurf.configPath, '{"mcpServers":{}}');
    writeMcpConfig(windsurf, 'local');
    expect(() => readFileSync(windsurf.configPath + BACKUP_SUFFIX)).toThrow();
    const copilot: EditorTarget = {
      name: 'Copilot CLI',
      configPath: path.join(dir, 'c', 'mcp-config.json'),
      format: 'copilot',
      hooks: { host: 'copilot', path: path.join(dir, 'c', 'hooks', 'align.json') },
    };
    put(copilot.hooks!.path, '{"version":1,"hooks":{}}');
    writeMcpConfig(copilot, 'local');
    expect(() => readFileSync(copilot.hooks!.path + BACKUP_SUFFIX)).toThrow();
  });
});
