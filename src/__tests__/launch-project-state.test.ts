import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectState } from '../lib/launch/project-state.js';
import { writeClaudeCodeHook, writeManagedNudge, writeProjectMcpConfig } from '../lib/agent-rules.js';

let root: string, cwd: string, home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-ps-')));
  cwd = path.join(root, 'repo');
  home = path.join(root, 'home');
  mkdirSync(path.join(cwd, '.git'), { recursive: true });
  mkdirSync(home);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const put = (file: string, content: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
const NONE = { projectHasPreHook: false, projectHasPostHook: false, projectHasMcp: false, projectHasBlock: false };
const ALL = { projectHasPreHook: true, projectHasPostHook: true, projectHasMcp: true, projectHasBlock: true };
const localDefault = { localIsDefault: true };
const cloudDefault = { localIsDefault: false };
const hookGroup = (command: string) => [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command }] }];
const BLOCK = '<!-- align:start (managed by `align setup` - do not edit) -->\nx\n<!-- align:end -->\n';

describe('readProjectState: the basics', () => {
  it('reports nothing present in an empty project', () => {
    expect(readProjectState(cwd, home, localDefault)).toEqual(NONE);
  });
  it('sees what `align setup` wrote when the local graph is the default', () => {
    writeClaudeCodeHook(cwd);
    writeProjectMcpConfig(cwd);
    writeManagedNudge(cwd);
    expect(readProjectState(cwd, home, localDefault)).toEqual(ALL);
  });
  it('does not count setup\'s prod-default hook and server when the default graph is NOT local', () => {
    writeClaudeCodeHook(cwd);
    writeProjectMcpConfig(cwd);
    expect(readProjectState(cwd, home, cloudDefault)).toMatchObject({ projectHasPreHook: false, projectHasPostHook: false, projectHasMcp: false });
  });
  it('does not mistake the user\'s own hooks and servers for align\'s', () => {
    put(path.join(cwd, '.claude', 'settings.json'), { hooks: { PreToolUse: hookGroup('echo hi') } });
    put(path.join(cwd, '.mcp.json'), { mcpServers: { other: { command: 'x' } } });
    put(path.join(cwd, 'CLAUDE.md'), '# mine\n');
    expect(readProjectState(cwd, home, localDefault)).toEqual(NONE);
  });
  it('treats unreadable JSON as absent rather than throwing', () => {
    put(path.join(cwd, '.claude', 'settings.json'), '{not json');
    expect(readProjectState(cwd, home, localDefault)).toEqual(NONE);
  });
});

describe('readProjectState: hooks', () => {
  const both = (cmd: string) => ({ hooks: { PreToolUse: hookGroup(cmd), PostToolUse: hookGroup(cmd) } });
  it.each([
    ['.claude/settings.json', (c: string, _h: string) => path.join(c, '.claude', 'settings.json')],
    ['.claude/settings.local.json', (c: string, _h: string) => path.join(c, '.claude', 'settings.local.json')],
    ['~/.claude/settings.json', (_c: string, h: string) => path.join(h, '.claude', 'settings.json')],
  ])('counts a local align hook in %s', (_label, where) => {
    put(where(cwd, home), both('align check --advisory --env local'));
    expect(readProjectState(cwd, home, cloudDefault)).toMatchObject({ projectHasPreHook: true, projectHasPostHook: true });
  });
  it('judges Pre and Post independently', () => {
    put(path.join(cwd, '.claude', 'settings.json'), { hooks: { PreToolUse: hookGroup('align check --advisory --env local') } });
    expect(readProjectState(cwd, home, localDefault)).toMatchObject({ projectHasPreHook: true, projectHasPostHook: false });
    put(path.join(cwd, '.claude', 'settings.json'), { hooks: { PostToolUse: hookGroup('align check --advisory --env local') } });
    expect(readProjectState(cwd, home, localDefault)).toMatchObject({ projectHasPreHook: false, projectHasPostHook: true });
  });
  it('a hook against another environment does not count; one with no --env counts only when local is the default', () => {
    put(path.join(cwd, '.claude', 'settings.json'), both('align check --advisory --env preview'));
    expect(readProjectState(cwd, home, localDefault).projectHasPreHook).toBe(false);
    put(path.join(cwd, '.claude', 'settings.json'), both('align check --advisory'));
    expect(readProjectState(cwd, home, localDefault).projectHasPreHook).toBe(true);
    expect(readProjectState(cwd, home, cloudDefault).projectHasPreHook).toBe(false);
  });
});

describe('readProjectState: the MCP server', () => {
  const entry = (args: string[]) => ({ mcpServers: { align: { command: 'align', args } } });
  it.each([
    ['project .mcp.json', () => path.join(cwd, '.mcp.json'), (a: string[]) => entry(a)],
    ['~/.claude.json top level', () => path.join(home, '.claude.json'), (a: string[]) => entry(a)],
    ['~/.claude.json under this project', () => path.join(home, '.claude.json'), (a: string[]) => ({ projects: { [cwd]: entry(a) } })],
  ])('counts a local align server in %s', (_l, file, shape) => {
    put(file(), shape(['mcp', '--env', 'local']));
    expect(readProjectState(cwd, home, cloudDefault).projectHasMcp).toBe(true);
  });
  it('accepts --env=local and the Windows cmd /c wrapper', () => {
    put(path.join(cwd, '.mcp.json'), { mcpServers: { align: { command: 'cmd', args: ['/c', 'align', 'mcp', '--env=local'] } } });
    expect(readProjectState(cwd, home, cloudDefault).projectHasMcp).toBe(true);
  });
  it('a server on another environment does not count, so ours is injected', () => {
    put(path.join(cwd, '.mcp.json'), entry(['mcp', '--env', 'prod']));
    expect(readProjectState(cwd, home, localDefault).projectHasMcp).toBe(false);
  });
  it('a server with no --env counts only when local is the default', () => {
    put(path.join(cwd, '.mcp.json'), entry(['mcp']));
    expect(readProjectState(cwd, home, localDefault).projectHasMcp).toBe(true);
    expect(readProjectState(cwd, home, cloudDefault).projectHasMcp).toBe(false);
  });
  it('an "align" entry that is not the align MCP command does not count', () => {
    put(path.join(cwd, '.mcp.json'), { mcpServers: { align: { command: 'node', args: ['my-server.js'] } } });
    expect(readProjectState(cwd, home, localDefault).projectHasMcp).toBe(false);
  });
  it.each([
    ['project settings.json', () => path.join(cwd, '.claude', 'settings.json')],
    ['settings.local.json', () => path.join(cwd, '.claude', 'settings.local.json')],
    ['~/.claude/settings.json', () => path.join(home, '.claude', 'settings.json')],
  ])('a .mcp.json server disabled in %s does not count', (_l, file) => {
    put(path.join(cwd, '.mcp.json'), entry(['mcp', '--env', 'local']));
    put(file(), { disabledMcpjsonServers: ['align'] });
    expect(readProjectState(cwd, home, localDefault).projectHasMcp).toBe(false);
  });
});

describe('readProjectState: the managed CLAUDE.md block', () => {
  it.each([
    ['CLAUDE.md', () => path.join(cwd, 'CLAUDE.md')],
    ['.claude/CLAUDE.md', () => path.join(cwd, '.claude', 'CLAUDE.md')],
    ['CLAUDE.local.md', () => path.join(cwd, 'CLAUDE.local.md')],
    ['~/.claude/CLAUDE.md', () => path.join(home, '.claude', 'CLAUDE.md')],
    ['an ancestor directory inside the repo', () => path.join(cwd, 'CLAUDE.md')],
  ])('counts the block in %s', (_l, file) => {
    put(file(), BLOCK);
    const start = _l.startsWith('an ancestor') ? path.join(cwd, 'packages', 'a') : cwd;
    mkdirSync(start, { recursive: true });
    expect(readProjectState(start, home, localDefault).projectHasBlock).toBe(true);
  });
  // https://code.claude.com/docs/en/memory ("How CLAUDE.md files load"): Claude Code loads
  // CLAUDE.md and CLAUDE.local.md "from your current working directory and every directory
  // above it". Nothing there stops at a git root, so neither do we.
  it('counts a block above the repo root, because Claude Code loads every directory above the cwd', () => {
    put(path.join(root, 'CLAUDE.md'), BLOCK);
    expect(readProjectState(cwd, home, localDefault).projectHasBlock).toBe(true);
  });
  it('a CLAUDE.md without the marker does not count', () => {
    put(path.join(cwd, 'CLAUDE.md'), '# mine\n');
    expect(readProjectState(cwd, home, localDefault).projectHasBlock).toBe(false);
  });
});
