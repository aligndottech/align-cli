import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AmpLaunchContext, buildAmpLaunch } from '../lib/launch/adapters/amp.js';
import { ampSettingsFile, readAmpState } from '../lib/launch/amp-state.js';
import { applyConfigWrite } from '../lib/launch/config-writes.js';
import { mergeWrittenConfig, setWriteRecorder, undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';
import { pinPlatform, setPlatform } from './helpers/platform.js';

/*
 * Wave B, Amp (amp 0.0.1791576029, sandbox-installed from npm; the platform binary run with
 * `amp mcp list` / `amp mcp add`). WRITTEN ONCE: `--mcp-config` was dropped because Amp writes
 * whatever that flag brought in back into the user's settings on `amp mcp add/remove`, where
 * undo cannot see it. align-local goes into the user's settings file (`amp.mcpServers`) once,
 * through the safe writer, with exact undo. A commented settings file is never rewritten.
 */
pinPlatform('linux');
const LOCAL = { command: 'align', args: ['mcp', '--env', 'local'] };
const BASE: AmpLaunchContext = { passthrough: [], present: false, overridden: [], settingsFile: '/u/amp/settings.json', commented: false };
const ctx = (over: Partial<AmpLaunchContext> = {}): AmpLaunchContext => ({ ...BASE, ...over });

describe('buildAmpLaunch (written once)', () => {
  it('nothing present: one mcp-entry write under amp.mcpServers, no flags, the user\'s args alone', () => {
    expect(buildAmpLaunch(ctx({ passthrough: ['threads', 'continue', '--', 'x'] }))).toEqual({
      bin: 'amp',
      args: ['threads', 'continue', '--', 'x'],
      env: { ALIGN_WRAPPED: '1' },
      files: [],
      writes: [{ kind: 'mcp-entry', file: '/u/amp/settings.json', topKey: 'amp.mcpServers', name: 'align-local', entry: LOCAL }],
    });
  });

  it('already present: no write, no flags', () => {
    const spec = buildAmpLaunch(ctx({ present: true, passthrough: ['-x'] }));
    expect(spec.args).toEqual(['-x']);
    expect(spec).not.toHaveProperty('writes');
  });

  it('a conflicting align-local (user or workspace): no write, the session still opens, one line naming the file', () => {
    const spec = buildAmpLaunch(ctx({ conflict: '/r/.amp/settings.json', passthrough: ['a'] }));
    expect(spec).not.toHaveProperty('writes');
    expect(spec.args).toEqual(['a']);
    expect(spec.notes).toEqual(['/r/.amp/settings.json defines its own align-local MCP server, so Align did not add its graph to Amp. Remove that entry to use the graph.']);
  });

  it('a commented settings file is never rewritten: no write, one line with the command to add it by hand', () => {
    const spec = buildAmpLaunch(ctx({ commented: true }));
    expect(spec).not.toHaveProperty('writes');
    expect(spec.notes).toEqual(['/u/amp/settings.json has comments, and Align does not rewrite a file it would strip them from. Add the graph yourself: amp mcp add align-local -- align mcp --env local']);
  });

  it('never passes --mcp-config (Amp would persist it into the user\'s settings)', () => {
    for (const c of [ctx(), ctx({ present: true }), ctx({ commented: true })]) expect(buildAmpLaunch(c).args).not.toContain('--mcp-config');
  });

  it('on win32 the entry goes through cmd /c', () => {
    setPlatform('win32');
    expect(buildAmpLaunch(ctx()).writes![0]!.entry).toEqual({ command: 'cmd', args: ['/c', 'align', 'mcp', '--env', 'local'] });
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
  const userFile = () => path.join(xdg, 'amp', 'settings.json');
  const user = (text: string) => writeFileSync(userFile(), text);
  const workspace = (dir: string, v: unknown) => { mkdirSync(path.join(dir, '.amp'), { recursive: true }); writeFileSync(path.join(dir, '.amp', 'settings.json'), JSON.stringify(v)); };

  it('finds the settings file: --settings-file, else AMP_SETTINGS_FILE, else XDG_CONFIG_HOME, else ~/.config', () => {
    expect(ampSettingsFile(home, {}, ['--settings-file', '/f.json'])).toBe(path.resolve('/f.json'));
    expect(ampSettingsFile(home, { AMP_SETTINGS_FILE: '/e.json' }, [])).toBe(path.resolve('/e.json'));
    expect(ampSettingsFile(home, { XDG_CONFIG_HOME: '/x' }, [])).toBe(path.join('/x', 'amp', 'settings.json'));
    expect(ampSettingsFile(home, {}, [])).toBe(path.join(home, '.config', 'amp', 'settings.json'));
    expect(state().settingsFile).toBe(userFile());
  });

  it('a canonical align or align-local in the user settings is present; another graph is not', () => {
    expect(state().present).toBe(false);
    user(JSON.stringify({ 'amp.mcpServers': { align: LOCAL } }));
    expect(state().present).toBe(true);
    user(JSON.stringify({ 'amp.mcpServers': { 'align-local': LOCAL } }));
    expect(state().present).toBe(true);
    user(JSON.stringify({ 'amp.mcpServers': { align: { ...LOCAL, args: ['mcp', '--env', 'prod'] } } }));
    expect(state().present).toBe(false);
  });

  it('comments in the settings file: commented (read the way Amp reads it); plain JSON is not', () => {
    user(`{\n  // mine\n  "amp.mcpServers": {}\n}`);
    expect(state()).toMatchObject({ commented: true, present: false });
    user(`{\n  // mine\n  "amp.mcpServers": { "align": ${JSON.stringify(LOCAL)} }\n}`);
    expect(state()).toMatchObject({ commented: true, present: true });
    user('{"amp.mcpServers": {}}');
    expect(state().commented).toBe(false);
  });

  it('a non-canonical align-local in the user file is a conflict (the writer never edits an entry)', () => {
    user(JSON.stringify({ 'amp.mcpServers': { 'align-local': { command: 'evil' } } }));
    expect(state()).toMatchObject({ present: false, conflict: userFile() });
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
});

describe('the Amp write, and undo after Amp itself edited the file', () => {
  let root: string, f: string, manifest: Record<string, WrittenConfig>;
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-amp-w-')));
    mkdirSync(path.join(root, 'amp'));
    f = path.join(root, 'amp', 'settings.json');
    manifest = {};
    setWriteRecorder((file, e) => { manifest[file] = mergeWrittenConfig(manifest[file], e); }, (file) => manifest[file]);
  });
  afterEach(() => { setWriteRecorder(undefined); rmSync(root, { recursive: true, force: true }); });
  const write = () => applyConfigWrite({ ...buildAmpLaunch(ctx({ settingsFile: f })).writes![0]!, root }, () => {});

  it('writes once; untouched, undo puts the file back byte for byte', () => {
    const original = '{"amp.mcpServers": {"user_own": {"command": "echo"}}, "amp.other": true}\n';
    writeFileSync(f, original);
    write();
    const once = readFileSync(f, 'utf8');
    expect(JSON.parse(once)['amp.mcpServers']).toEqual({ user_own: { command: 'echo' }, 'align-local': LOCAL });
    write();
    expect(readFileSync(f, 'utf8')).toBe(once);
    expect(undoWrittenConfigs(manifest).restored).toEqual([f]);
    expect(sha(readFileSync(f, 'utf8'))).toBe(sha(original));
  });

  // What `amp mcp add zz -- echo hi` (amp 0.0.1791576029) did to align's write in a sandbox: it
  // kept align-local as written and added its own entry after it.
  it('after `amp mcp add zz`, undo leaves the file as Amp left it, minus align-local', () => {
    writeFileSync(f, '{"amp.mcpServers": {"user_own": {"command": "echo", "args": ["hi"]}}, "amp.other": true}\n');
    write();
    const cur = JSON.parse(readFileSync(f, 'utf8'));
    cur['amp.mcpServers'].zz = { command: 'echo', args: ['hi'] };
    writeFileSync(f, `${JSON.stringify(cur, null, 2)}\n`);
    expect(undoWrittenConfigs(manifest).cleaned).toEqual([f]);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ 'amp.mcpServers': { user_own: { command: 'echo', args: ['hi'] }, zz: { command: 'echo', args: ['hi'] } }, 'amp.other': true });
  });

  it('if Amp rewrote align-local itself, undo skips it, keeps the backup, and says so', () => {
    writeFileSync(f, '{"amp.mcpServers": {}}\n');
    write();
    const cur = JSON.parse(readFileSync(f, 'utf8'));
    cur['amp.mcpServers']['align-local'] = { ...LOCAL, _target: 'flag' };
    writeFileSync(f, JSON.stringify(cur));
    const report = undoWrittenConfigs(manifest);
    expect(report.cleaned).toEqual([]);
    expect(report.skipped.join('\n')).toContain('align-local');
    expect(readFileSync(`${f}.align-backup`, 'utf8')).toBe('{"amp.mcpServers": {}}\n');
  });
});
