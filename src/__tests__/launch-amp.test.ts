import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AmpLaunchContext, buildAmpLaunch } from '../lib/launch/adapters/amp.js';
import { ampSettingsFile, readAmpState } from '../lib/launch/amp-state.js';
import { pinPlatform, setPlatform } from './helpers/platform.js';

/*
 * Wave B, Amp (amp 0.0.1791576029, sandbox-installed from npm; the platform binary run with
 * `amp --mcp-config f mcp list`): `--mcp-config` merges a bare { name: entry } map with the
 * user's settings, replaces a same-named USER server, and is listed BESIDE a same-named
 * WORKSPACE server. So: per session, a user align-local overridden, a workspace one a conflict.
 */
pinPlatform('linux');
const LOCAL = { command: 'align', args: ['mcp', '--env', 'local'] };
const BASE: AmpLaunchContext = { passthrough: [], cachePath: (n) => `/cache/${n}`, present: false, overridden: [] };
const ctx = (over: Partial<AmpLaunchContext> = {}): AmpLaunchContext => ({ ...BASE, ...over });
const fileOf = (spec: ReturnType<typeof buildAmpLaunch>) => JSON.parse(spec.files.find((f) => f.name === 'amp-mcp.json')?.content ?? 'null');

describe('buildAmpLaunch', () => {
  it('passes --mcp-config FIRST with a bare { align-local } map; the user\'s args follow untouched', () => {
    const spec = buildAmpLaunch(ctx({ passthrough: ['threads', 'continue', '--', 'x'] }));
    expect(spec.bin).toBe('amp');
    expect(spec.args).toEqual(['--mcp-config', '/cache/amp-mcp.json', 'threads', 'continue', '--', 'x']);
    expect(fileOf(spec)).toEqual({ 'align-local': LOCAL });
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(spec.notes ?? []).toEqual([]);
  });

  it('already present: no flag and no file', () => {
    const spec = buildAmpLaunch(ctx({ present: true, passthrough: ['-x'] }));
    expect(spec.args).toEqual(['-x']);
    expect(spec.files).toEqual([]);
  });

  it('a user align-local is replaced by ours (Amp\'s flag wins there), naming the file', () => {
    const spec = buildAmpLaunch(ctx({ present: false, overridden: ['/u/amp/settings.json'] }));
    expect(spec.args.slice(0, 2)).toEqual(['--mcp-config', '/cache/amp-mcp.json']);
    expect(spec.notes).toEqual(["Amp will use Align's own align-local MCP server this session, not the one in /u/amp/settings.json."]);
  });

  it('a workspace align-local is a conflict: no flag, the session still opens, one line', () => {
    const spec = buildAmpLaunch(ctx({ conflict: '/r/.amp/settings.json', passthrough: ['a'] }));
    expect(spec.args).toEqual(['a']);
    expect(spec.notes).toEqual(["/r/.amp/settings.json redefines the align-local MCP server, so Align's graph is off for this Amp session. Remove that entry to use the graph here."]);
  });

  it('the user\'s own --mcp-config is kept: no second one, one line', () => {
    const spec = buildAmpLaunch(ctx({ ownMcpConfig: '/me.json', passthrough: ['--mcp-config', '/me.json'] }));
    expect(spec.args).toEqual(['--mcp-config', '/me.json']);
    expect(spec.notes).toEqual(['Amp is using your own --mcp-config (/me.json), so Align did not add its graph tools to this session.']);
  });

  it('never approves anything for the user (no --dangerously-allow-all, no mcp approve)', () => {
    expect(buildAmpLaunch(ctx()).args.join(' ')).not.toMatch(/allow-all|approve/);
  });

  it('on win32 the entry goes through cmd /c', () => {
    setPlatform('win32');
    expect(fileOf(buildAmpLaunch(ctx()))['align-local']).toEqual({ command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] });
  });
});

describe('readAmpState (sandbox files)', () => {
  let root: string, home: string, proj: string, xdg: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-amp-state-')));
    home = path.join(root, 'home');
    xdg = path.join(root, 'xdg');
    proj = path.join(root, 'repo', 'sub');
    mkdirSync(path.join(xdg, 'amp'), { recursive: true });
    mkdirSync(proj, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const env = () => ({ XDG_CONFIG_HOME: xdg });
  const state = (o: { env?: Record<string, string>; passthrough?: string[] } = {}) => readAmpState(proj, home, { localIsDefault: false }, o.env ?? env(), 'linux', o.passthrough ?? []);
  const user = (text: string) => writeFileSync(path.join(xdg, 'amp', 'settings.json'), text);
  const workspace = (dir: string, v: unknown) => { mkdirSync(path.join(dir, '.amp'), { recursive: true }); writeFileSync(path.join(dir, '.amp', 'settings.json'), JSON.stringify(v)); };

  it('finds the settings file: --settings-file, else AMP_SETTINGS_FILE, else XDG_CONFIG_HOME, else ~/.config', () => {
    expect(ampSettingsFile(home, {}, ['--settings-file', '/f.json'])).toBe('/f.json');
    expect(ampSettingsFile(home, { AMP_SETTINGS_FILE: '/e.json' }, [])).toBe('/e.json');
    expect(ampSettingsFile(home, { XDG_CONFIG_HOME: '/x' }, [])).toBe('/x/amp/settings.json');
    expect(ampSettingsFile(home, {}, [])).toBe(path.join(home, '.config', 'amp', 'settings.json'));
  });

  it('a canonical align or align-local in the user settings is present, read as JSONC the way Amp reads it', () => {
    expect(state().present).toBe(false);
    user(`{\n  // mine\n  "amp.mcpServers": { "align": ${JSON.stringify(LOCAL)} }\n}`);
    expect(state().present).toBe(true);
    user(`{ "amp.mcpServers": { "align-local": ${JSON.stringify(LOCAL)} } }`);
    expect(state().present).toBe(true);
  });

  it('a non-canonical user align-local is overridden; one on another graph is not present', () => {
    user(JSON.stringify({ 'amp.mcpServers': { 'align-local': { command: 'evil' } } }));
    expect(state()).toMatchObject({ present: false, overridden: [path.join(xdg, 'amp', 'settings.json')] });
    user(JSON.stringify({ 'amp.mcpServers': { align: { ...LOCAL, args: ['mcp', '--env', 'prod'] } } }));
    expect(state()).toMatchObject({ present: false, overridden: [] });
  });

  it('a non-canonical align-local in a .amp/settings.json up the tree is a conflict; a canonical one is not', () => {
    workspace(path.join(root, 'repo'), { 'amp.mcpServers': { 'align-local': { command: 'evil' } } });
    expect(state().conflict).toBe(path.join(root, 'repo', '.amp', 'settings.json'));
    workspace(path.join(root, 'repo'), { 'amp.mcpServers': { 'align-local': LOCAL } });
    expect(state().conflict).toBeUndefined();
  });

  it('a workspace align never counts as present (Amp holds workspace servers for approval)', () => {
    workspace(proj, { 'amp.mcpServers': { align: LOCAL } });
    expect(state().present).toBe(false);
  });

  it('notes the user\'s own --mcp-config, but not one after --', () => {
    expect(state({ passthrough: ['--mcp-config', '{"x":{}}'] }).ownMcpConfig).toBe('{"x":{}}');
    expect(state({ passthrough: ['--', '--mcp-config', 'f'] }).ownMcpConfig).toBeUndefined();
  });
});
