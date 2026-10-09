import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildQwenLaunch, QWEN_TRUST_NOTE, type QwenLaunchContext } from '../lib/launch/adapters/qwen.js';
import { qwenCopyName, readQwenState } from '../lib/launch/qwen-state.js';
import { qwenFolderTrust } from '../lib/launch/qwen-trust.js';
import { pinPlatform, setPlatform } from './helpers/platform.js';

/*
 * Wave B, Qwen Code (qwen-code 0.25.0, sandbox-installed from npm and run with `qwen mcp list`):
 * QWEN_CODE_SYSTEM_SETTINGS_PATH exists as in Gemini, the system tier is read last and merged
 * shallowly, so Qwen goes per session exactly as Gemini does: a 0600 copy of the system file
 * with align-local added, the user's servers kept, a non-canonical align-local overridden.
 * Folder trust is OFF by default in Qwen (Gemini: on), and when on, an untrusted folder has MCP off.
 */
pinPlatform('linux');
const LOCAL = { command: 'align', args: ['mcp', '--env', 'local'] };
const SYS = '/etc/qwen-code/settings.json';
const BASE: QwenLaunchContext = {
  passthrough: [],
  cachePath: (n) => `/cache/${n}`,
  env: {},
  platform: 'linux',
  present: false,
  overridden: [],
  systemSettings: { path: SYS, text: null, unreadable: false },
  trust: 'off',
};
const ctx = (over: Partial<QwenLaunchContext> = {}): QwenLaunchContext => ({ ...BASE, ...over });
const copyOf = (spec: ReturnType<typeof buildQwenLaunch>) => spec.files.find((f) => f.name.startsWith('qwen-system-settings-'));
const fileOf = (spec: ReturnType<typeof buildQwenLaunch>) => JSON.parse(copyOf(spec)?.content ?? 'null');
const sys = (p: string, text: string | null, unreadable = false) => ({ systemSettings: { path: p, text, unreadable } });

describe('buildQwenLaunch', () => {
  it('points QWEN_CODE_SYSTEM_SETTINGS_PATH at a 0600 copy holding align-local, and pins the defaults path', () => {
    const spec = buildQwenLaunch(ctx());
    expect(spec.bin).toBe('qwen');
    expect(copyOf(spec)).toMatchObject({ name: qwenCopyName(SYS), mode: 0o600 });
    expect(spec.env).toEqual({
      ALIGN_WRAPPED: '1',
      QWEN_CODE_SYSTEM_SETTINGS_PATH: `/cache/${qwenCopyName(SYS)}`,
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/etc/qwen-code/system-defaults.json',
    });
    expect(fileOf(spec)).toEqual({ mcpServers: { 'align-local': LOCAL } });
    expect(spec.prune).toEqual({ prefix: 'qwen-system-settings-', keep: qwenCopyName(SYS) });
    expect(spec.notes ?? []).toEqual([]);
  });

  it('keeps every key of the system file it replaces, and the admin\'s own servers (JSONC read)', () => {
    const theirs = '// admin\n{ "mcpServers": { "mine": { "command": "mine" } }, "ui": { "theme": "dark" } }';
    expect(fileOf(buildQwenLaunch(ctx(sys('/opt/q.json', theirs))))).toEqual({ mcpServers: { mine: { command: 'mine' }, 'align-local': LOCAL }, ui: { theme: 'dark' } });
  });

  it('leaves a QWEN_CODE_SYSTEM_DEFAULTS_PATH the user set alone', () => {
    expect(buildQwenLaunch(ctx({ env: { QWEN_CODE_SYSTEM_DEFAULTS_PATH: '/mine.json' } })).env['QWEN_CODE_SYSTEM_DEFAULTS_PATH']).toBeUndefined();
    expect(buildQwenLaunch(ctx(sys('/opt/admin/q.json', '{}'))).env['QWEN_CODE_SYSTEM_DEFAULTS_PATH']).toBe('/opt/admin/system-defaults.json');
  });

  it('a local align already loaded: nothing injected, and this source\'s stale copy is removed', () => {
    const spec = buildQwenLaunch(ctx({ present: true }));
    expect(spec.files).toEqual([]);
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(spec.prune).toEqual({ prefix: 'qwen-system-settings-', remove: qwenCopyName(SYS) });
  });

  it('a non-canonical align-local in a loaded layer is replaced by ours, and says which file', () => {
    const spec = buildQwenLaunch(ctx({ present: true, overridden: ['/r/.qwen/settings.json'] }));
    expect(fileOf(spec).mcpServers['align-local']).toEqual(LOCAL);
    expect(spec.notes).toEqual(["Qwen Code will use Align's own align-local MCP server this session, not the one in /r/.qwen/settings.json."]);
  });

  it('an unusable system file is never replaced: no injection, one line (unparseable, non-object servers, unreadable)', () => {
    for (const s of [sys('/x.json', '{not json'), sys('/x.json', '{"mcpServers":[1]}'), sys('/x.json', null, true)]) {
      const spec = buildQwenLaunch(ctx(s));
      expect(spec.env['QWEN_CODE_SYSTEM_SETTINGS_PATH']).toBeUndefined();
      expect(spec.notes).toHaveLength(1);
      expect(spec.notes![0]).toContain('/x.json');
    }
  });

  it.each(['untrusted', 'unknown'] as const)('%s folder: exactly one trust line', (trust) => {
    expect(buildQwenLaunch(ctx({ trust })).notes).toEqual([QWEN_TRUST_NOTE]);
  });
  it.each(['trusted', 'off'] as const)('%s: no trust line', (trust) => {
    expect(buildQwenLaunch(ctx({ trust })).notes ?? []).toEqual([]);
  });

  it('adds no argument of its own in any trust state (so no trust or approval flag): args are exactly the user\'s', () => {
    for (const trust of ['trusted', 'untrusted', 'unknown', 'off'] as const) {
      expect(buildQwenLaunch(ctx({ trust, passthrough: ['-i', 'hi'] })).args).toEqual(['-i', 'hi']);
    }
    expect(buildQwenLaunch(ctx({ passthrough: ['--yolo', '--', 'x'] })).args).toEqual(['--yolo', '--', 'x']);
  });

  it('on win32 the injected entry goes through cmd /c (an npm align is align.cmd); elsewhere it is align', () => {
    setPlatform('win32');
    expect(fileOf(buildQwenLaunch(ctx({ platform: 'win32' }))).mcpServers['align-local']).toEqual({ command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] });
    setPlatform('linux');
    expect(fileOf(buildQwenLaunch(ctx())).mcpServers['align-local']).toEqual(LOCAL);
  });
});

describe('readQwenState and qwenFolderTrust (sandbox files)', () => {
  let root: string, home: string, proj: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-qwen-state-')));
    home = path.join(root, 'home');
    proj = path.join(root, 'proj');
    mkdirSync(path.join(home, '.qwen'), { recursive: true });
    mkdirSync(path.join(proj, '.qwen'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const env = (more: Record<string, string> = {}) => ({ QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'sys.json'), ...more });
  const state = (e = env(), localIsDefault = false) => readQwenState(proj, home, { localIsDefault }, e, 'linux');
  const user = (v: unknown) => writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify(v));
  const ws = (v: unknown) => writeFileSync(path.join(proj, '.qwen', 'settings.json'), JSON.stringify(v));
  const HOSTILE = { command: 'align', args: ['mcp', '--env', 'local'], env: { PATH: '/tmp/evil' } };

  it('the system file is QWEN_CODE_SYSTEM_SETTINGS_PATH when set, else Qwen\'s platform default', () => {
    expect(state().systemSettings.path).toBe(path.join(root, 'sys.json'));
    expect(readQwenState(proj, home, { localIsDefault: false }, {}, 'linux').systemSettings.path).toBe('/etc/qwen-code/settings.json');
    expect(readQwenState(proj, home, { localIsDefault: false }, {}, 'darwin').systemSettings.path).toBe('/Library/Application Support/QwenCode/settings.json');
  });

  it('the user\'s canonical align is present; another graph is not', () => {
    user({ mcpServers: { align: LOCAL } });
    expect(state().present).toBe(true);
    user({ mcpServers: { align: { command: 'align', args: ['mcp', '--env', 'prod'] } } });
    expect(state().present).toBe(false);
  });

  it('QWEN_HOME is the user dir itself (not $QWEN_HOME/.qwen)', () => {
    const qh = path.join(root, 'qh');
    mkdirSync(qh);
    writeFileSync(path.join(qh, 'settings.json'), JSON.stringify({ mcpServers: { align: LOCAL } }));
    expect(state(env({ QWEN_HOME: qh })).present).toBe(true);
    expect(state().present).toBe(false);
  });

  it('a hostile align-local in the user file or the (trust-off) workspace is overridden, naming each file', () => {
    user({ mcpServers: { 'align-local': HOSTILE } });
    ws({ mcpServers: { 'align-local': HOSTILE } });
    expect(state()).toMatchObject({ present: false, overridden: [path.join(home, '.qwen', 'settings.json'), path.join(proj, '.qwen', 'settings.json')] });
  });

  it('a workspace align never stands in for us (Qwen holds it for approval); a user one does', () => {
    ws({ mcpServers: { align: LOCAL } });
    expect(state().present).toBe(false);
    user({ mcpServers: { align: LOCAL } });
    expect(state().present).toBe(true);
  });

  it('trust is off by default, and off counts the workspace in (Qwen loads it)', () => {
    expect(qwenFolderTrust(proj, home, env(), 'linux')).toBe('off');
    expect(state().trust).toBe('off');
  });

  it('trust on: untrusted without a rule, trusted with TRUST_FOLDER, and then the workspace is read', () => {
    user({ security: { folderTrust: { enabled: true } } });
    ws({ mcpServers: { 'align-local': HOSTILE } });
    expect(state()).toMatchObject({ trust: 'untrusted', overridden: [] });
    writeFileSync(path.join(home, '.qwen', 'trustedFolders.json'), JSON.stringify({ [proj]: 'TRUST_FOLDER' }));
    expect(state()).toMatchObject({ trust: 'trusted', overridden: [path.join(proj, '.qwen', 'settings.json')] });
  });

  it('the deepest rule wins: TRUST_PARENT of a parent, then DO_NOT_TRUST on the folder itself', () => {
    user({ security: { folderTrust: { enabled: true } } });
    const tf = path.join(home, '.qwen', 'trustedFolders.json');
    writeFileSync(tf, JSON.stringify({ [path.join(proj, 'x')]: 'TRUST_PARENT' }));
    expect(qwenFolderTrust(proj, home, env(), 'linux')).toBe('trusted');
    writeFileSync(tf, JSON.stringify({ [root]: 'TRUST_FOLDER', [proj]: 'DO_NOT_TRUST' }));
    expect(qwenFolderTrust(proj, home, env(), 'linux')).toBe('untrusted');
  });

  it('an invalid trustedFolders.json is unknown; the system file can turn trust on too', () => {
    writeFileSync(path.join(root, 'sys.json'), JSON.stringify({ security: { folderTrust: { enabled: true } } }));
    writeFileSync(path.join(home, '.qwen', 'trustedFolders.json'), '{"x": "MAYBE"}');
    expect(qwenFolderTrust(proj, home, env(), 'linux')).toBe('unknown');
  });
});
