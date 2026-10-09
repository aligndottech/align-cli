import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildKiroLaunch, type KiroLaunchContext } from '../lib/launch/adapters/kiro.js';
import { readKiroState } from '../lib/launch/kiro-state.js';
import { pinPlatform } from './helpers/platform.js';

/*
 * Wave B, Kiro CLI, from its DOCS only (installer is a script, never run; no npm package):
 * written once into ~/.kiro/settings/mcp.json, no custom agent file (the safe branch), no flags.
 * Workspace .kiro/settings/mcp.json "takes precedence" per server, so a non-canonical
 * align-local there is a conflict and nothing is written.
 */
pinPlatform('linux');
const LOCAL = { command: 'align', args: ['mcp', '--env', 'local'] };
const BASE: KiroLaunchContext = { passthrough: [], present: false, overridden: [], mcpFile: '/home/u/.kiro/settings/mcp.json' };
const ctx = (over: Partial<KiroLaunchContext> = {}): KiroLaunchContext => ({ ...BASE, ...over });

describe('buildKiroLaunch', () => {
  it('nothing present: one mcp-entry write to the global mcp.json, no flags, no agent file', () => {
    const spec = buildKiroLaunch(ctx({ passthrough: ['chat'] }));
    expect(spec).toEqual({
      bin: 'kiro-cli',
      args: ['chat'],
      env: { ALIGN_WRAPPED: '1' },
      files: [],
      writes: [{ kind: 'mcp-entry', file: '/home/u/.kiro/settings/mcp.json', topKey: 'mcpServers', name: 'align-local', entry: LOCAL }],
    });
  });

  it('present: no write', () => {
    expect(buildKiroLaunch(ctx({ present: true }))).not.toHaveProperty('writes');
  });

  it('a conflicting align-local: no write, one line naming the file, the session still opens', () => {
    const spec = buildKiroLaunch(ctx({ conflict: '/r/.kiro/settings/mcp.json', passthrough: ['chat'] }));
    expect(spec).not.toHaveProperty('writes');
    expect(spec.args).toEqual(['chat']);
    expect(spec.notes).toEqual(['/r/.kiro/settings/mcp.json defines its own align-local MCP server, so Align did not add its graph to Kiro. Remove that entry to use the graph.']);
  });

  it('never selects an agent or trusts tools for the user', () => {
    expect(buildKiroLaunch(ctx()).args.join(' ')).not.toMatch(/--agent|trust/);
  });
});

describe('readKiroState (sandbox files)', () => {
  let root: string, home: string, proj: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-kiro-state-')));
    home = path.join(root, 'home');
    proj = path.join(root, 'repo', 'sub');
    mkdirSync(path.join(home, '.kiro', 'settings'), { recursive: true });
    mkdirSync(proj, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const state = (env: Record<string, string> = {}) => readKiroState(proj, home, { localIsDefault: false }, env, 'linux');
  const global = (v: unknown) => writeFileSync(path.join(home, '.kiro', 'settings', 'mcp.json'), JSON.stringify(v));
  const workspace = (dir: string, v: unknown) => { mkdirSync(path.join(dir, '.kiro', 'settings'), { recursive: true }); writeFileSync(path.join(dir, '.kiro', 'settings', 'mcp.json'), JSON.stringify(v)); };

  it('the file to add to is ~/.kiro/settings/mcp.json, or under KIRO_HOME', () => {
    expect(state().mcpFile).toBe(path.join(home, '.kiro', 'settings', 'mcp.json'));
    expect(state({ KIRO_HOME: path.join(root, 'k') }).mcpFile).toBe(path.join(root, 'k', 'settings', 'mcp.json'));
  });

  it('a canonical align or align-local, global or workspace, is present; another graph is not', () => {
    expect(state().present).toBe(false);
    global({ mcpServers: { align: LOCAL } });
    expect(state().present).toBe(true);
    global({ mcpServers: { align: { ...LOCAL, args: ['mcp', '--env', 'prod'] } } });
    expect(state().present).toBe(false);
    workspace(path.join(root, 'repo'), { mcpServers: { 'align-local': LOCAL } });
    expect(state().present).toBe(true);
  });

  it('a non-canonical align-local in a workspace up the tree or in the global file is a conflict', () => {
    workspace(path.join(root, 'repo'), { mcpServers: { 'align-local': { ...LOCAL, env: { PATH: '/evil' } } } });
    expect(state().conflict).toBe(path.join(root, 'repo', '.kiro', 'settings', 'mcp.json'));
    rmSync(path.join(root, 'repo', '.kiro'), { recursive: true });
    global({ mcpServers: { 'align-local': { command: 'other' } } });
    expect(state().conflict).toBe(path.join(home, '.kiro', 'settings', 'mcp.json'));
  });

  it('a disabled canonical entry is not present (configured, not running)', () => {
    global({ mcpServers: { 'align-local': { ...LOCAL, disabled: true } } });
    expect(state()).toMatchObject({ present: false, conflict: path.join(home, '.kiro', 'settings', 'mcp.json') });
  });
});
