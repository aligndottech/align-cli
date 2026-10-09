import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGeminiLaunch, GEMINI_TRUST_NOTE, type GeminiLaunchContext } from '../lib/launch/adapters/gemini-cli.js';
import { readGeminiState } from '../lib/launch/gemini-state.js';
import { restorePlatform, setPlatform } from './helpers/platform.js';

/*
 * Wave A Test List (Gemini CLI 0.58.0, per session through GEMINI_CLI_SYSTEM_SETTINGS_PATH,
 * which MERGES with the user's own servers - verified with `gemini mcp list`):
 *  1. nothing present: env points at a cache copy of the system settings plus align-local
 *  2. the system file Gemini would have read (the user's var, else the platform default) is
 *     merged, never dropped; system-defaults keep coming from where they came from before
 *  3. an unusable system file -> no injection and one line saying why
 *  4. an existing local entry -> no injection
 *  5. trust: untrusted/unknown -> exactly one line; trusted/off -> none
 *  6. never --skip-trust, never GEMINI_CLI_TRUST_WORKSPACE; the user's own args pass unchanged
 */
const LOCAL = { command: 'align', args: ['mcp', '--env', 'local'] };
const BASE: GeminiLaunchContext = {
  passthrough: [],
  cachePath: (n) => `/cache/${n}`,
  env: {},
  platform: 'linux',
  projectHasMcp: false,
  systemSettings: { path: '/etc/gemini-cli/settings.json', text: null, unreadable: false },
  trust: 'trusted',
};
const ctx = (over: Partial<GeminiLaunchContext> = {}): GeminiLaunchContext => ({ ...BASE, ...over });
const fileOf = (spec: ReturnType<typeof buildGeminiLaunch>) => JSON.parse(spec.files.find((f) => f.name === 'gemini-system-settings.json')?.content ?? 'null');

describe('buildGeminiLaunch: injection', () => {
  afterAll(restorePlatform);
  beforeEach(() => setPlatform('linux'));

  it('points GEMINI_CLI_SYSTEM_SETTINGS_PATH at a launch file holding align-local when nothing is present', () => {
    const spec = buildGeminiLaunch(ctx());
    expect(spec.bin).toBe('gemini');
    expect(spec.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']).toBe('/cache/gemini-system-settings.json');
    expect(fileOf(spec)).toEqual({ mcpServers: { 'align-local': LOCAL } });
    expect(spec.env['ALIGN_WRAPPED']).toBe('1');
    expect(spec.notes ?? []).toEqual([]);
  });

  it('keeps system-defaults where Gemini read them before (it derives them from the settings path\'s dir)', () => {
    expect(buildGeminiLaunch(ctx()).env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']).toBe('/etc/gemini-cli/system-defaults.json');
    const theirs = ctx({ systemSettings: { path: '/opt/admin/gem.json', text: '{}', unreadable: false } });
    expect(buildGeminiLaunch(theirs).env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']).toBe('/opt/admin/system-defaults.json');
  });

  it('leaves a GEMINI_CLI_SYSTEM_DEFAULTS_PATH the user set alone (it is inherited as is)', () => {
    expect(buildGeminiLaunch(ctx({ env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/mine/d.json' } })).env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']).toBeUndefined();
  });

  it('merges the system file Gemini would have read, keeping every key, not just the servers', () => {
    const theirs = { mcpServers: { mine: { command: 'mine' } }, hooks: { BeforeTool: [{ matcher: 'x' }] }, ui: { theme: 'dark' } };
    const spec = buildGeminiLaunch(ctx({ systemSettings: { path: '/opt/admin/gem.json', text: JSON.stringify(theirs), unreadable: false } }));
    expect(fileOf(spec)).toEqual({ ...theirs, mcpServers: { mine: { command: 'mine' }, 'align-local': LOCAL } });
  });

  it('never touches a server named align in that file', () => {
    const theirs = { mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'prod'] } } };
    const spec = buildGeminiLaunch(ctx({ systemSettings: { path: '/x.json', text: JSON.stringify(theirs), unreadable: false } }));
    expect(fileOf(spec).mcpServers.align).toEqual(theirs.mcpServers.align);
    expect(Object.keys(fileOf(spec).mcpServers).sort()).toEqual(['align', 'align-local']);
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a non-object', '[1]'],
    ['mcpServers of the wrong type', '{"mcpServers":[]}'],
  ])('an unusable system file (%s): no injection, one line naming the file', (_l, text) => {
    const spec = buildGeminiLaunch(ctx({ systemSettings: { path: '/opt/admin/gem.json', text, unreadable: false } }));
    expect(spec.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']).toBeUndefined();
    expect(spec.env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']).toBeUndefined();
    expect(spec.files).toEqual([]);
    expect(spec.notes).toHaveLength(1);
    expect(spec.notes![0]).toContain('/opt/admin/gem.json');
    expect(spec.notes![0]).toMatch(/graph tools were not added/);
  });

  it('an unreadable system file: same, no injection and one line', () => {
    const spec = buildGeminiLaunch(ctx({ systemSettings: { path: '/etc/gemini-cli/settings.json', text: null, unreadable: true } }));
    expect(spec.files).toEqual([]);
    expect(spec.notes).toHaveLength(1);
  });

  it('a usable file, or one that is absent, says nothing', () => {
    expect(buildGeminiLaunch(ctx({ systemSettings: { path: '/x.json', text: '{"ui":{}}', unreadable: false } })).notes ?? []).toEqual([]);
    expect(buildGeminiLaunch(ctx()).notes ?? []).toEqual([]);
  });

  it('a local entry already present: no env, no file, no note', () => {
    const spec = buildGeminiLaunch(ctx({ projectHasMcp: true, systemSettings: { path: '/x.json', text: '{bad', unreadable: false } }));
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(spec.files).toEqual([]);
    expect(spec.notes ?? []).toEqual([]);
  });

  it('an align-local already in the system file is not added again', () => {
    const theirs = { mcpServers: { 'align-local': { command: 'theirs' } } };
    const spec = buildGeminiLaunch(ctx({ systemSettings: { path: '/x.json', text: JSON.stringify(theirs), unreadable: false } }));
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(spec.files).toEqual([]);
  });

  it('on win32 the server goes through cmd /c and the default dir is ProgramData', () => {
    setPlatform('win32');
    const spec = buildGeminiLaunch(ctx({ platform: 'win32', systemSettings: { path: 'C:\\ProgramData\\gemini-cli\\settings.json', text: null, unreadable: false } }));
    expect(fileOf(spec).mcpServers['align-local']).toEqual({ command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] });
    expect(spec.env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']).toBe('C:\\ProgramData\\gemini-cli\\system-defaults.json');
  });
});

describe('buildGeminiLaunch: trust and args', () => {
  it.each(['untrusted', 'unknown'] as const)('%s folder: exactly one line, the trust hint', (trust) => {
    expect(buildGeminiLaunch(ctx({ trust })).notes).toEqual([GEMINI_TRUST_NOTE]);
  });
  it.each(['trusted', 'off'] as const)('%s: no trust line', (trust) => {
    expect(buildGeminiLaunch(ctx({ trust })).notes ?? []).toEqual([]);
  });
  it('the trust line says what Gemini does and that the user decides', () => {
    expect(GEMINI_TRUST_NOTE).toBe("Gemini turns off MCP servers, Align's included, in folders you haven't trusted - trust this folder when Gemini asks.");
  });

  it('never trusts on the user\'s behalf, in any context', () => {
    for (const trust of ['trusted', 'untrusted', 'unknown', 'off'] as const) {
      const spec = buildGeminiLaunch(ctx({ trust }));
      expect(spec.args).not.toContain('--skip-trust');
      expect(spec.env['GEMINI_CLI_TRUST_WORKSPACE']).toBeUndefined();
    }
  });

  it('passes the user\'s args through unchanged and alone, their own --skip-trust included', () => {
    expect(buildGeminiLaunch(ctx({ passthrough: ['-p', 'hi'] })).args).toEqual(['-p', 'hi']);
    expect(buildGeminiLaunch(ctx({ passthrough: ['--skip-trust', '--', 'x'] })).args).toEqual(['--skip-trust', '--', 'x']);
  });
});

describe('readGeminiState', () => {
  let root: string;
  let home: string;
  let proj: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'align-gemini-state-'));
    home = path.join(root, 'home');
    proj = path.join(root, 'proj');
    mkdirSync(path.join(home, '.gemini'), { recursive: true });
    mkdirSync(proj, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const sysEnv = () => ({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, 'sys.json') });
  const state = (env: Record<string, string | undefined> = sysEnv(), platform = 'linux', localIsDefault = false) => readGeminiState(proj, home, { localIsDefault }, env, platform);
  const userSettings = (v: unknown) => writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify(v));

  it('the system file is the user\'s var when set, else the platform default', () => {
    expect(state().systemSettings.path).toBe(path.join(root, 'sys.json'));
    expect(state({}, 'linux').systemSettings.path).toBe('/etc/gemini-cli/settings.json');
    expect(state({}, 'darwin').systemSettings.path).toBe('/Library/Application Support/GeminiCli/settings.json');
    expect(state({}, 'win32').systemSettings.path).toBe('C:\\ProgramData\\gemini-cli\\settings.json');
  });

  it('reads the system file\'s text, null when absent, unreadable for a directory', () => {
    expect(state().systemSettings).toMatchObject({ text: null, unreadable: false });
    writeFileSync(path.join(root, 'sys.json'), '{"a":1}');
    expect(state().systemSettings).toMatchObject({ text: '{"a":1}', unreadable: false });
    rmSync(path.join(root, 'sys.json'));
    mkdirSync(path.join(root, 'sys.json'));
    expect(state().systemSettings).toMatchObject({ text: null, unreadable: true });
  });

  it('a local align entry in the user, project or system settings is present', () => {
    expect(state().projectHasMcp).toBe(false);
    userSettings({ mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'local'] } } });
    expect(state().projectHasMcp).toBe(true);
    rmSync(path.join(home, '.gemini', 'settings.json'));
    mkdirSync(path.join(proj, '.gemini'));
    writeFileSync(path.join(proj, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { 'align-local': { command: 'x' } } }));
    expect(state().projectHasMcp).toBe(true);
  });

  it('an align entry aimed at another graph is absent', () => {
    userSettings({ mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'prod'] } } });
    expect(state().projectHasMcp).toBe(false);
  });

  it('reads GEMINI_CLI_HOME for the user settings', () => {
    const gh = path.join(root, 'gh');
    mkdirSync(path.join(gh, '.gemini'), { recursive: true });
    writeFileSync(path.join(gh, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { 'align-local': {} } }));
    expect(state({ ...sysEnv(), GEMINI_CLI_HOME: gh }).projectHasMcp).toBe(true);
    expect(state().projectHasMcp).toBe(false);
  });

  it('carries the folder trust verdict', () => {
    expect(state().trust).toBe('untrusted');
    writeFileSync(path.join(home, '.gemini', 'trustedFolders.json'), JSON.stringify({ [proj]: 'TRUST_FOLDER' }));
    expect(state().trust).toBe('trusted');
  });
});
