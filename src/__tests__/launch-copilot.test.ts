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
const BASE: CopilotLaunchContext = { passthrough: [], present: false, overridden: [], cachePath: (n) => `/cache/${n}` };
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
    const spec = buildCopilotLaunch(ctx({ present: true, passthrough: ['-p', 'hi'] }));
    expect(spec.args).toEqual(['-p', 'hi']);
    expect(spec.files).toEqual([]);
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
  });

  it('never sets COPILOT_HOME (it also holds the user\'s auth), and holds no secret-bearing field', () => {
    for (const present of [false, true]) {
      const spec = buildCopilotLaunch(ctx({ present }));
      expect(Object.keys(spec.env)).toEqual(['ALIGN_WRAPPED']);
    }
    expect(JSON.stringify(buildCopilotLaunch(ctx()))).not.toMatch(/token|secret|api[_-]?key/i);
  });

  it('a file that redefines align-local: no flag, no file, one line naming it (Copilot may merge it)', () => {
    const spec = buildCopilotLaunch(ctx({ conflict: '/repo/.mcp.json', passthrough: ['-p', 'hi'] }));
    expect(spec.args).toEqual(['-p', 'hi']);
    expect(spec.files).toEqual([]);
    expect(spec.notes).toEqual(["/repo/.mcp.json redefines the align-local MCP server, so Align's graph is off for this Copilot session. Remove that entry to use the graph here."]);
  });

  it('a plain injection prints nothing', () => {
    expect(buildCopilotLaunch(ctx()).notes ?? []).toEqual([]);
  });

  it('on win32 the server goes through cmd /c', () => {
    setPlatform('win32');
    expect(fileOf(buildCopilotLaunch(ctx())).mcpServers['align-local']).toMatchObject({ command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] });
  });
});

describe('readCopilotState', () => {
  let root: string;
  let home: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'align-copilot-state-'));
    home = path.join(root, 'home');
    repo = path.join(root, 'repo');
    mkdirSync(path.join(home, '.copilot'), { recursive: true });
    mkdirSync(path.join(repo, '.git'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const CANON = { type: 'local', command: 'align', args: ['mcp', '--env', 'local'], tools: ['*'] };
  const HOSTILE = { ...CANON, env: { PATH: '/tmp/evil' } };
  const userCfg = (dir: string, v: unknown) => writeFileSync(path.join(dir, 'mcp-config.json'), JSON.stringify(v));
  const put = (file: string, v: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(v));
  };
  const state = (o: { cwd?: string; env?: Record<string, string | undefined>; platform?: string; localIsDefault?: boolean } = {}) =>
    readCopilotState(o.cwd ?? repo, home, { localIsDefault: o.localIsDefault ?? false }, o.env ?? {}, o.platform ?? 'linux');

  it('nothing configured: not present, no conflict', () => {
    expect(state()).toEqual({ present: false, overridden: [] });
  });

  it('a canonical align-local or align in the user config is present', () => {
    userCfg(path.join(home, '.copilot'), { mcpServers: { 'align-local': CANON } });
    expect(state().present).toBe(true);
    userCfg(path.join(home, '.copilot'), { mcpServers: { align: CANON } });
    expect(state().present).toBe(true);
  });

  it('align without the tools allowlist, at another graph, or a shell that mentions align is not present', () => {
    userCfg(path.join(home, '.copilot'), { mcpServers: { align: { type: 'local', command: 'align', args: ['mcp', '--env', 'local'] } } });
    expect(state().present).toBe(false);
    userCfg(path.join(home, '.copilot'), { mcpServers: { align: { ...CANON, args: ['mcp', '--env', 'prod'] } } });
    expect(state().present).toBe(false);
    userCfg(path.join(home, '.copilot'), { mcpServers: { align: { ...CANON, command: 'sh', args: ['-c', 'evil', 'align', 'mcp'] } } });
    expect(state({ localIsDefault: true }).present).toBe(false);
  });

  it('a workspace entry counts as present only when Copilot is told to trust everything (COPILOT_ALLOW_ALL)', () => {
    put(path.join(repo, '.mcp.json'), { mcpServers: { 'align-local': CANON } });
    expect(state().present).toBe(false);
    expect(state({ env: { COPILOT_ALLOW_ALL: 'true' } }).present).toBe(true);
  });

  it('on win32 the committed bare-align .mcp.json is not present, so the injection proceeds', () => {
    put(path.join(repo, '.mcp.json'), { mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'local'] } } });
    expect(state({ platform: 'win32', env: { COPILOT_ALLOW_ALL: 'true' } })).toEqual({ present: false, overridden: [] });
    put(path.join(repo, '.mcp.json'), { mcpServers: { align: { ...CANON, command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] } } });
    expect(state({ platform: 'win32', env: { COPILOT_ALLOW_ALL: 'true' } }).present).toBe(true);
  });

  it('a workspace align-local that is not canonical is a conflict naming the file, trusted or not (Copilot\'s trust is not readable)', () => {
    put(path.join(repo, '.github', 'mcp.json'), { mcpServers: { 'align-local': HOSTILE } });
    expect(state().conflict).toBe(path.join(repo, '.github', 'mcp.json'));
    put(path.join(repo, '.github', 'mcp.json'), { mcpServers: { 'align-local': CANON } });
    expect(state().conflict).toBeUndefined();
  });

  it('a user align-local that is not canonical is a conflict too', () => {
    userCfg(path.join(home, '.copilot'), { mcpServers: { 'align-local': { ...CANON, tools: ['align_ask'] } } });
    expect(state().conflict).toBe(path.join(home, '.copilot', 'mcp-config.json'));
  });

  it('walks from cwd up to the git root and never past it', () => {
    const sub = path.join(repo, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    put(path.join(repo, '.mcp.json'), { mcpServers: { 'align-local': HOSTILE } });
    expect(state({ cwd: sub }).conflict).toBe(path.join(repo, '.mcp.json'));
    rmSync(path.join(repo, '.mcp.json'));
    put(path.join(root, '.mcp.json'), { mcpServers: { 'align-local': HOSTILE } });
    expect(state({ cwd: sub }).conflict).toBeUndefined();
  });

  it('with no .git it reads the cwd only, never a parent', () => {
    rmSync(path.join(repo, '.git'), { recursive: true });
    const sub = path.join(repo, 'sub');
    mkdirSync(sub);
    put(path.join(repo, '.mcp.json'), { mcpServers: { 'align-local': HOSTILE } });
    expect(state({ cwd: sub }).conflict).toBeUndefined();
    put(path.join(sub, '.mcp.json'), { mcpServers: { 'align-local': HOSTILE } });
    expect(state({ cwd: sub }).conflict).toBe(path.join(sub, '.mcp.json'));
  });

  it('reads $COPILOT_HOME/mcp-config.json when the user set it, and not ~/.copilot then', () => {
    const ch = path.join(root, 'ch');
    mkdirSync(ch);
    userCfg(ch, { mcpServers: { 'align-local': CANON } });
    expect(state({ env: { COPILOT_HOME: ch } }).present).toBe(true);
    rmSync(path.join(ch, 'mcp-config.json'));
    userCfg(path.join(home, '.copilot'), { mcpServers: { 'align-local': CANON } });
    expect(state({ env: { COPILOT_HOME: ch } }).present).toBe(false);
  });

  it('an unparseable file reads as absent, not as a throw', () => {
    writeFileSync(path.join(home, '.copilot', 'mcp-config.json'), '{bad');
    expect(state()).toEqual({ present: false, overridden: [] });
  });
});
