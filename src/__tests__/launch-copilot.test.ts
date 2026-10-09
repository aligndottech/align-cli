import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCopilotLaunch, type CopilotLaunchContext } from '../lib/launch/adapters/copilot.js';
import { readCopilotState } from '../lib/launch/copilot-state.js';
import { restorePlatform, setPlatform } from './helpers/platform.js';

/*
 * Wave A Test List (GitHub Copilot CLI 1.0.95, per session: `copilot --help` lists
 * `--additional-mcp-config <json>`, "JSON string or file path (prefix with @) ... augments
 * config from ~/.copilot/mcp-config.json for this session"):
 *  1. nothing present: a launch file holding align-local (type local, tools ['*']) and one flag
 *  2. the flag goes FIRST: `copilot mcp list --additional-mcp-config` is rejected by the
 *     subcommand (verified), `copilot --additional-mcp-config @f mcp list` is accepted
 *  3. an existing local entry -> no flag, no file
 *  4. COPILOT_HOME is never set; a user-set COPILOT_HOME is where their config is read from
 *  5. win32 goes through cmd /c; ALIGN_WRAPPED always set
 */
const BASE: CopilotLaunchContext = { passthrough: [], projectHasMcp: false, cachePath: (n) => `/cache/${n}` };
const ctx = (over: Partial<CopilotLaunchContext> = {}): CopilotLaunchContext => ({ ...BASE, ...over });
const fileOf = (spec: ReturnType<typeof buildCopilotLaunch>) => JSON.parse(spec.files.find((f) => f.name === 'copilot-mcp.json')?.content ?? 'null');

describe('buildCopilotLaunch', () => {
  afterAll(restorePlatform);
  beforeEach(() => setPlatform('linux'));

  it('adds align-local for this session through --additional-mcp-config @<launch file>', () => {
    const spec = buildCopilotLaunch(ctx());
    expect(spec.bin).toBe('copilot');
    expect(spec.args).toEqual(['--additional-mcp-config', '@/cache/copilot-mcp.json']);
    expect(fileOf(spec)).toEqual({ mcpServers: { 'align-local': { type: 'local', command: 'align', args: ['mcp', '--env', 'local'], tools: ['*'] } } });
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(spec.writes).toBeUndefined();
  });

  it('never defines a server named align', () => {
    expect(Object.keys(fileOf(buildCopilotLaunch(ctx())).mcpServers)).toEqual(['align-local']);
  });

  it('puts the flag before the user\'s args (a subcommand rejects it) and keeps theirs in order', () => {
    expect(buildCopilotLaunch(ctx({ passthrough: ['--resume', 'abc'] })).args).toEqual(['--additional-mcp-config', '@/cache/copilot-mcp.json', '--resume', 'abc']);
    expect(buildCopilotLaunch(ctx({ passthrough: ['-p', 'hi', '--', 'x'] })).args.slice(2)).toEqual(['-p', 'hi', '--', 'x']);
  });

  it('with a local entry already present: no flag, no file, only the user\'s args', () => {
    const spec = buildCopilotLaunch(ctx({ projectHasMcp: true, passthrough: ['-p', 'hi'] }));
    expect(spec.args).toEqual(['-p', 'hi']);
    expect(spec.files).toEqual([]);
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
  });

  it('never sets COPILOT_HOME (it also holds the user\'s auth), and holds no secret-bearing field', () => {
    for (const projectHasMcp of [false, true]) {
      const spec = buildCopilotLaunch(ctx({ projectHasMcp }));
      expect(Object.keys(spec.env)).toEqual(['ALIGN_WRAPPED']);
    }
    expect(JSON.stringify(buildCopilotLaunch(ctx()))).not.toMatch(/token|secret|api[_-]?key/i);
  });

  it('on win32 the server goes through cmd /c', () => {
    setPlatform('win32');
    expect(fileOf(buildCopilotLaunch(ctx())).mcpServers['align-local']).toMatchObject({ command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] });
  });
});

describe('readCopilotState', () => {
  let root: string;
  let home: string;
  let proj: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'align-copilot-state-'));
    home = path.join(root, 'home');
    proj = path.join(root, 'proj');
    mkdirSync(path.join(home, '.copilot'), { recursive: true });
    mkdirSync(path.join(proj, '.git'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const userCfg = (dir: string, v: unknown) => writeFileSync(path.join(dir, 'mcp-config.json'), JSON.stringify(v));
  const state = (env: Record<string, string | undefined> = {}, localIsDefault = false) => readCopilotState(proj, home, { localIsDefault }, env);

  it('nothing configured: absent', () => {
    expect(state().projectHasMcp).toBe(false);
  });

  it('align-local, or an align entry at --env local, in ~/.copilot/mcp-config.json is present', () => {
    userCfg(path.join(home, '.copilot'), { mcpServers: { 'align-local': { type: 'local' } } });
    expect(state().projectHasMcp).toBe(true);
    userCfg(path.join(home, '.copilot'), { mcpServers: { align: { type: 'local', command: 'align', args: ['mcp', '--env', 'local'], tools: ['*'] } } });
    expect(state().projectHasMcp).toBe(true);
  });

  it('an align entry aimed at another graph is absent', () => {
    userCfg(path.join(home, '.copilot'), { mcpServers: { align: { type: 'local', command: 'align', args: ['mcp', '--env', 'prod'] } } });
    expect(state().projectHasMcp).toBe(false);
  });

  it('reads $COPILOT_HOME/mcp-config.json when the user set it, and not ~/.copilot then', () => {
    const ch = path.join(root, 'ch');
    mkdirSync(ch);
    userCfg(ch, { mcpServers: { 'align-local': {} } });
    expect(state({ COPILOT_HOME: ch }).projectHasMcp).toBe(true);
    rmSync(path.join(ch, 'mcp-config.json'));
    userCfg(path.join(home, '.copilot'), { mcpServers: { 'align-local': {} } });
    expect(state({ COPILOT_HOME: ch }).projectHasMcp).toBe(false);
  });

  it('reads the workspace .mcp.json and .github/mcp.json', () => {
    writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'align-local': {} } }));
    expect(state().projectHasMcp).toBe(true);
    rmSync(path.join(proj, '.mcp.json'));
    mkdirSync(path.join(proj, '.github'));
    writeFileSync(path.join(proj, '.github', 'mcp.json'), JSON.stringify({ mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'local'] } } }));
    expect(state().projectHasMcp).toBe(true);
  });

  it('an unparseable file reads as absent, not as a throw', () => {
    writeFileSync(path.join(home, '.copilot', 'mcp-config.json'), '{bad');
    expect(state().projectHasMcp).toBe(false);
  });
});
