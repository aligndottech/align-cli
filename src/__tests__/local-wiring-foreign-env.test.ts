/**
 * The local wizard must never overwrite an `align` entry that targets a team env. A team user
 * who runs `align setup --env local` (or whose wizard runs on a machine wired to prod) keeps
 * their prod MCP entry, hooks and committed .mcp.json untouched; everything else is still
 * written, and one stderr line names each file left alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupAgentAlignment } from '../lib/agent-rules.js';
import { type EditorTarget, writeMcpConfig } from '../lib/mcp-setup.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'align-foreign-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const PROD_ENTRY = { command: 'align', args: ['mcp'] };
const PREVIEW_ENTRY = { command: 'align', args: ['mcp', '--env', 'preview'] };
const LOCAL_ENTRY = { command: 'align', args: ['mcp', '--env', 'local'] };
const read = (f: string) => readFileSync(f, 'utf8');

function mcpJson(servers: Record<string, unknown>): string {
  return `${JSON.stringify({ mcpServers: servers, other: 1 }, null, 2)}\n`;
}

describe('project files: setupAgentAlignment with env local', () => {
  it.each([['prod', PROD_ENTRY], ['preview', PREVIEW_ENTRY]])(
    'leaves a committed .mcp.json align entry for %s untouched and names the file',
    (_name, entry) => {
      const file = path.join(dir, '.mcp.json');
      writeFileSync(file, mcpJson({ align: entry, mine: { command: 'x' } }));
      const before = read(file);
      const skipped: string[] = [];
      const written = setupAgentAlignment({ cwd: dir, env: 'local', onForeign: (f) => skipped.push(f) });
      expect(read(file)).toBe(before);
      expect(skipped).toContain('.mcp.json');
      expect(written).not.toContain('.mcp.json');
      // Everything else is still written.
      expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(path.join(dir, '.cursor/rules/align.md'))).toBe(true);
    },
  );

  it('still rewrites an align entry that is already local (a re-run is idempotent)', () => {
    const file = path.join(dir, '.mcp.json');
    writeFileSync(file, mcpJson({ align: LOCAL_ENTRY }));
    const skipped: string[] = [];
    setupAgentAlignment({ cwd: dir, env: 'local', onForeign: (f) => skipped.push(f) });
    expect(skipped).not.toContain('.mcp.json');
    expect(JSON.parse(read(file)).mcpServers.align.args).toEqual(['mcp', '--env', 'local']);
  });

  it('writes the entry when none exists (the solo path is unchanged)', () => {
    setupAgentAlignment({ cwd: dir, env: 'local', onForeign: () => { throw new Error('nothing to skip'); } });
    expect(JSON.parse(read(path.join(dir, '.mcp.json'))).mcpServers.align.args).toEqual(['mcp', '--env', 'local']);
  });

  it('leaves a prod align PreToolUse/PostToolUse hook in .claude/settings.json untouched', () => {
    const file = path.join(dir, '.claude/settings.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const prodHook = { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'align check --advisory', timeout: 10 }] };
    writeFileSync(file, `${JSON.stringify({ hooks: { PreToolUse: [prodHook], PostToolUse: [prodHook] } }, null, 2)}\n`);
    const before = read(file);
    const skipped: string[] = [];
    setupAgentAlignment({ cwd: dir, env: 'local', onForeign: (f) => skipped.push(f) });
    expect(read(file)).toBe(before);
    expect(skipped).toContain('.claude/settings.json');
  });

  it('leaves a preview align hook in .gemini/settings.json untouched', () => {
    const file = path.join(dir, '.gemini/settings.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const hook = { matcher: 'write_file|replace', hooks: [{ type: 'command', command: 'align check --advisory --format gemini --env preview' }] };
    writeFileSync(file, `${JSON.stringify({ hooks: { BeforeTool: [hook], AfterTool: [hook] } }, null, 2)}\n`);
    const before = read(file);
    const skipped: string[] = [];
    setupAgentAlignment({ cwd: dir, env: 'local', onForeign: (f) => skipped.push(f) });
    expect(read(file)).toBe(before);
    expect(skipped).toContain('.gemini/settings.json');
  });

  it('a team (non-local) setup still overwrites, as today', () => {
    const file = path.join(dir, '.mcp.json');
    writeFileSync(file, mcpJson({ align: PREVIEW_ENTRY }));
    setupAgentAlignment({ cwd: dir, env: 'prod', onForeign: () => { throw new Error('team setup never skips'); } });
    expect(JSON.parse(read(file)).mcpServers.align.args).toEqual(['mcp']);
  });
});

describe('global agent configs: writeMcpConfig with env local', () => {
  const target = (file: string, format: EditorTarget['format'] = 'mcpServers'): EditorTarget =>
    ({ name: 'Claude Code', configPath: file, format });

  it.each([['prod', PROD_ENTRY], ['preview', PREVIEW_ENTRY]])('leaves a %s entry in ~/.claude.json untouched', (_n, entry) => {
    const file = path.join(dir, '.claude.json');
    writeFileSync(file, mcpJson({ align: entry }));
    const before = read(file);
    const skipped: string[] = [];
    const written = writeMcpConfig(target(file), 'local', (f) => skipped.push(f));
    expect(read(file)).toBe(before);
    expect(skipped).toEqual([file]);
    expect(written).toEqual([]);
  });

  it('adds a local entry beside other servers when there is no align entry', () => {
    const file = path.join(dir, '.claude.json');
    writeFileSync(file, mcpJson({ mine: { command: 'x' } }));
    const written = writeMcpConfig(target(file), 'local', () => { throw new Error('nothing to skip'); });
    const parsed = JSON.parse(read(file));
    expect(parsed.mcpServers.mine).toEqual({ command: 'x' });
    expect(parsed.mcpServers.align.args).toEqual(['mcp', '--env', 'local']);
    expect(written).toEqual([file]);
  });

  it('leaves a hand-written Codex [mcp_servers.align] table for prod untouched', () => {
    const file = path.join(dir, 'config.toml');
    writeFileSync(file, '[mcp_servers.align]\ncommand = "align"\nargs = ["mcp"]\n');
    const before = read(file);
    const skipped: string[] = [];
    writeMcpConfig(target(file, 'codex'), 'local', (f) => skipped.push(f));
    expect(read(file)).toBe(before);
    expect(skipped).toEqual([file]);
  });

  it('replaces a managed Codex block that is already local, and writes one when absent', () => {
    const file = path.join(dir, 'config.toml');
    writeMcpConfig(target(file, 'codex'), 'local', () => { throw new Error('nothing to skip'); });
    expect(read(file)).toContain('"--env", "local"');
    writeMcpConfig(target(file, 'codex'), 'local', () => { throw new Error('local is ours to rewrite'); });
    expect(read(file).match(/\[mcp_servers\.align\]/g)).toHaveLength(1);
  });

  it('leaves a prod Codex managed block untouched too', () => {
    const file = path.join(dir, 'config.toml');
    writeMcpConfig(target(file, 'codex'), undefined);
    const before = read(file);
    const skipped: string[] = [];
    writeMcpConfig(target(file, 'codex'), 'local', (f) => skipped.push(f));
    expect(read(file)).toBe(before);
    expect(skipped).toEqual([file]);
  });
});
