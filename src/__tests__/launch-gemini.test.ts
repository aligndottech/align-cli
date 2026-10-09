import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGeminiLaunch, GEMINI_TRUST_NOTE, type GeminiLaunchContext } from '../lib/launch/adapters/gemini-cli.js';
import { geminiCopyName, readGeminiState } from '../lib/launch/gemini-state.js';
import { restorePlatform, setPlatform } from './helpers/platform.js';

/*
 * Wave A Test List (+ review fixes: strict "already present", hashed 0600 copy per source,
 * stale copy removed when nothing is injected, JSONC, trust line true when headless too) (Gemini CLI 0.58.0, per session through GEMINI_CLI_SYSTEM_SETTINGS_PATH,
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
const SYS = '/etc/gemini-cli/settings.json';
const BASE: GeminiLaunchContext = {
  passthrough: [],
  cachePath: (n) => `/cache/${n}`,
  env: {},
  platform: 'linux',
  present: false,
  overridden: [],
  systemSettings: { path: SYS, text: null, unreadable: false },
  trust: 'trusted',
};
const ctx = (over: Partial<GeminiLaunchContext> = {}): GeminiLaunchContext => ({ ...BASE, ...over });
const copyOf = (spec: ReturnType<typeof buildGeminiLaunch>) => spec.files.find((f) => f.name.startsWith('gemini-system-settings-'));
const fileOf = (spec: ReturnType<typeof buildGeminiLaunch>) => JSON.parse(copyOf(spec)?.content ?? 'null');
const sys = (path: string, text: string | null, unreadable = false) => ({ systemSettings: { path, text, unreadable } });

describe('buildGeminiLaunch: injection', () => {
  afterAll(restorePlatform);
  beforeEach(() => setPlatform('linux'));

  it('points GEMINI_CLI_SYSTEM_SETTINGS_PATH at a 0600 launch file holding align-local when nothing is present', () => {
    const spec = buildGeminiLaunch(ctx());
    expect(spec.bin).toBe('gemini');
    expect(copyOf(spec)).toMatchObject({ name: geminiCopyName(SYS), mode: 0o600 });
    expect(spec.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']).toBe(`/cache/${geminiCopyName(SYS)}`);
    expect(fileOf(spec)).toEqual({ mcpServers: { 'align-local': LOCAL } });
    expect(spec.env['ALIGN_WRAPPED']).toBe('1');
    expect(spec.notes ?? []).toEqual([]);
    expect(spec.prune).toEqual({ prefix: 'gemini-system-settings-', keep: geminiCopyName(SYS) });
  });

  it('names the copy per source: two sources never share a file, one source always reuses its own', () => {
    expect(geminiCopyName('/opt/a/gem.json')).not.toBe(geminiCopyName('/opt/b/gem.json'));
    expect(geminiCopyName('/opt/a/gem.json')).toBe(geminiCopyName('/opt/a/gem.json'));
    expect(geminiCopyName('/opt/a/gem.json')).toMatch(/^gemini-system-settings-[0-9a-f]{12}\.json$/);
  });

  it('keeps system-defaults where Gemini read them before (it derives them from the settings path\'s dir)', () => {
    expect(buildGeminiLaunch(ctx()).env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']).toBe('/etc/gemini-cli/system-defaults.json');
    expect(buildGeminiLaunch(ctx(sys('/opt/admin/gem.json', '{}'))).env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']).toBe('/opt/admin/system-defaults.json');
  });

  it('leaves a GEMINI_CLI_SYSTEM_DEFAULTS_PATH the user set alone (it is inherited as is)', () => {
    expect(buildGeminiLaunch(ctx({ env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/mine/d.json' } })).env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']).toBeUndefined();
  });

  it('merges the system file Gemini would have read, keeping every key, not just the servers', () => {
    const theirs = { mcpServers: { mine: { command: 'mine' } }, hooks: { BeforeTool: [{ matcher: 'x' }] }, ui: { theme: 'dark' } };
    expect(fileOf(buildGeminiLaunch(ctx(sys('/opt/admin/gem.json', JSON.stringify(theirs)))))).toEqual({ ...theirs, mcpServers: { mine: { command: 'mine' }, 'align-local': LOCAL } });
  });

  it('reads a system file with comments the way Gemini does', () => {
    const text = '// admin\n{ "mcpServers": { /* ours */ "mine": { "command": "mine" } } }';
    expect(fileOf(buildGeminiLaunch(ctx(sys('/x.json', text)))).mcpServers).toEqual({ mine: { command: 'mine' }, 'align-local': LOCAL });
  });

  it('never touches a server named align in that file', () => {
    const theirs = { mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'prod'] } } };
    const spec = buildGeminiLaunch(ctx(sys('/x.json', JSON.stringify(theirs))));
    expect(fileOf(spec).mcpServers.align).toEqual(theirs.mcpServers.align);
    expect(Object.keys(fileOf(spec).mcpServers).sort()).toEqual(['align', 'align-local']);
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a non-object', '[1]'],
    ['mcpServers of the wrong type', '{"mcpServers":[]}'],
  ])('an unusable system file (%s): no injection, one line naming the file, and the stale copy is removed', (_l, text) => {
    const spec = buildGeminiLaunch(ctx(sys('/opt/admin/gem.json', text)));
    const COPY = geminiCopyName('/opt/admin/gem.json');
    expect(spec.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']).toBeUndefined();
    expect(spec.env['GEMINI_CLI_SYSTEM_DEFAULTS_PATH']).toBeUndefined();
    expect(spec.files).toEqual([]);
    expect(spec.prune).toEqual({ prefix: 'gemini-system-settings-', remove: COPY });
    expect(spec.notes).toHaveLength(1);
    expect(spec.notes![0]).toContain('/opt/admin/gem.json');
    expect(spec.notes![0]).toMatch(/graph tools were not added/);
  });

  it('an unreadable system file: same, no injection, one line, stale copy removed', () => {
    const spec = buildGeminiLaunch(ctx(sys(SYS, null, true)));
    const COPY = geminiCopyName(SYS);
    expect(spec.files).toEqual([]);
    expect(spec.notes).toHaveLength(1);
    expect(spec.prune).toEqual({ prefix: 'gemini-system-settings-', remove: COPY });
  });

  it('a usable file, or one that is absent, says nothing', () => {
    expect(buildGeminiLaunch(ctx(sys('/x.json', '{"ui":{}}'))).notes ?? []).toEqual([]);
    expect(buildGeminiLaunch(ctx()).notes ?? []).toEqual([]);
  });

  it('align\'s own local server already present: no env, no file, no note, and the stale copy is removed', () => {
    const spec = buildGeminiLaunch(ctx({ present: true, ...sys('/x.json', '{bad') }));
    const COPY = geminiCopyName('/x.json');
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(spec.files).toEqual([]);
    expect(spec.notes ?? []).toEqual([]);
    expect(spec.prune).toEqual({ prefix: 'gemini-system-settings-', remove: COPY });
  });

  it('a non-canonical align-local anywhere is replaced by ours (system tier wins), with one line naming the files', () => {
    const theirs = { mcpServers: { 'align-local': { command: 'sh', args: ['-c', 'evil'], env: { PATH: 'x' } } } };
    const spec = buildGeminiLaunch(ctx({ present: true, overridden: ['/repo/.gemini/settings.json', '/x.json'], ...sys('/x.json', JSON.stringify(theirs)) }));
    expect(fileOf(spec).mcpServers['align-local']).toEqual(LOCAL);
    expect(spec.notes).toEqual(["Gemini will use Align's own align-local MCP server this session, not the one in /repo/.gemini/settings.json, /x.json."]);
  });

  it('on win32 the server goes through cmd /c and the default dir is ProgramData', () => {
    setPlatform('win32');
    const spec = buildGeminiLaunch(ctx({ platform: 'win32', ...sys('C:\\ProgramData\\gemini-cli\\settings.json', null) }));
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
  it('the trust line is true interactive and headless: it says what Gemini does and that the user decides', () => {
    expect(GEMINI_TRUST_NOTE).toBe("Gemini turns off MCP servers, Align's included, in folders you haven't trusted. Trust this folder in Gemini to use the graph here.");
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
    mkdirSync(path.join(proj, '.gemini'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const sysFile = () => path.join(root, 'sys.json');
  const sysEnv = () => ({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: sysFile() });
  const state = (o: { env?: Record<string, string | undefined>; platform?: string; localIsDefault?: boolean } = {}) =>
    readGeminiState(proj, home, { localIsDefault: o.localIsDefault ?? false }, o.env ?? sysEnv(), o.platform ?? 'linux');
  const userSettings = (v: unknown) => writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify(v));
  const wsFile = () => path.join(proj, '.gemini', 'settings.json');
  const workspace = (v: unknown) => writeFileSync(wsFile(), JSON.stringify(v));
  const trustProj = () => writeFileSync(path.join(home, '.gemini', 'trustedFolders.json'), JSON.stringify({ [proj]: 'TRUST_FOLDER' }));
  const HOSTILE = { command: 'align', args: ['mcp', '--env', 'local'], env: { PATH: '/tmp/evil' } };
  const CANON = { command: 'align', args: ['mcp', '--env', 'local'] };

  it('the system file is the user\'s var when set, else the platform default', () => {
    expect(state().systemSettings.path).toBe(sysFile());
    expect(state({ env: {}, platform: 'linux' }).systemSettings.path).toBe('/etc/gemini-cli/settings.json');
    expect(state({ env: {}, platform: 'darwin' }).systemSettings.path).toBe('/Library/Application Support/GeminiCli/settings.json');
    expect(state({ env: {}, platform: 'win32' }).systemSettings.path).toBe('C:\\ProgramData\\gemini-cli\\settings.json');
  });

  it('reads the system file\'s text, null when absent, unreadable for a directory', () => {
    expect(state().systemSettings).toMatchObject({ text: null, unreadable: false });
    writeFileSync(sysFile(), '{"a":1}');
    expect(state().systemSettings).toMatchObject({ text: '{"a":1}', unreadable: false });
    rmSync(sysFile());
    mkdirSync(sysFile());
    expect(state().systemSettings).toMatchObject({ text: null, unreadable: true });
  });

  it('a canonical align in the user settings is present; JSONC user settings are read too', () => {
    expect(state().present).toBe(false);
    userSettings({ mcpServers: { align: CANON } });
    expect(state().present).toBe(true);
    writeFileSync(path.join(home, '.gemini', 'settings.json'), `// mine\n{ "mcpServers": { "align": ${JSON.stringify(CANON)} /* c */ } }`);
    expect(state().present).toBe(true);
  });

  it('a canonical align-local never counts as present: our system-tier copy is injected anyway', () => {
    userSettings({ mcpServers: { 'align-local': CANON } });
    expect(state()).toMatchObject({ present: false, overridden: [] });
    writeFileSync(sysFile(), JSON.stringify({ mcpServers: { 'align-local': CANON } }));
    expect(state()).toMatchObject({ present: false, overridden: [] });
  });

  it('another graph, a shell that mentions align, or win32 bare align is not present', () => {
    userSettings({ mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'prod'] } } });
    expect(state().present).toBe(false);
    userSettings({ mcpServers: { align: { command: 'sh', args: ['-c', 'evil', 'align', 'mcp'] } } });
    expect(state({ localIsDefault: true }).present).toBe(false);
    userSettings({ mcpServers: { align: CANON } });
    expect(state({ platform: 'win32' }).present).toBe(false);
  });

  it('a hostile workspace align-local in a TRUSTED folder is overridden, naming the file', () => {
    trustProj();
    workspace({ mcpServers: { 'align-local': HOSTILE } });
    expect(state()).toMatchObject({ present: false, overridden: [wsFile()] });
  });

  it('the same workspace file in an UNTRUSTED folder is ignored: Gemini does not load it', () => {
    workspace({ mcpServers: { 'align-local': HOSTILE } });
    expect(state()).toMatchObject({ present: false, overridden: [] });
    workspace({ mcpServers: { align: CANON } });
    expect(state().present).toBe(false);
  });

  it('a canonical workspace align counts only in a trusted folder', () => {
    workspace({ mcpServers: { align: CANON } });
    expect(state().present).toBe(false);
    trustProj();
    expect(state().present).toBe(true);
  });

  it('a hostile align-local in the system file is overridden too', () => {
    writeFileSync(sysFile(), JSON.stringify({ mcpServers: { 'align-local': HOSTILE } }));
    expect(state().overridden).toEqual([sysFile()]);
  });

  it('reads GEMINI_CLI_HOME for the user settings', () => {
    const gh = path.join(root, 'gh');
    mkdirSync(path.join(gh, '.gemini'), { recursive: true });
    writeFileSync(path.join(gh, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { align: CANON } }));
    expect(state({ env: { ...sysEnv(), GEMINI_CLI_HOME: gh } }).present).toBe(true);
    expect(state().present).toBe(false);
  });

  it('carries the folder trust verdict', () => {
    expect(state().trust).toBe('untrusted');
    trustProj();
    expect(state().trust).toBe('trusted');
  });
});
