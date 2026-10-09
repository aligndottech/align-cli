import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGrokLaunch, type GrokLaunchContext } from '../lib/launch/adapters/grok-build.js';
import { applyConfigWrite, type ConfigWrite } from '../lib/launch/config-writes.js';
import { grokHome, isGrokBuildBin, readGrokState } from '../lib/launch/grok-state.js';
import { mergeWrittenConfig, setWriteRecorder, undoWrittenConfigs, type WrittenConfig } from '../lib/safe-config-write.js';
import { pinPlatform } from './helpers/platform.js';

/*
 * Wave B, Grok Build (xAI's `grok` 1.0.50: the npm package's platform binary, decompressed into a
 * sandbox and run with `grok mcp list` / `grok inspect`; never its installer). No per-session MCP
 * input exists, so `[mcp_servers.align-local]` is appended once to $GROK_HOME/config.toml in an
 * align-owned block. `grok` is a generic name: it counts only from Grok Build's install places.
 */
pinPlatform('linux');
/** The real platform, read before pinPlatform swaps it: tests that walk real files must use the host's path rules. */
const HOST = process.platform;
const LOCAL = { command: 'align', args: ['mcp', '--env', 'local'] };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('isGrokBuildBin: the realpath gate on a generic `grok`', () => {
  const fsx = (links: Record<string, string>, exists: string[] = []) => ({
    realpath: (p: string) => { if (p in links) return links[p]!; throw new Error('ENOENT'); },
    exists: (p: string) => exists.includes(p),
  });
  const env = { HOME: '/home/u' };

  it('accepts the install script\'s layout: ~/.grok/bin/grok -> ~/.grok/downloads/grok-<platform>, also via ~/.local/bin', () => {
    expect(isGrokBuildBin('/home/u/.grok/bin/grok', env, 'linux', fsx({ '/home/u/.grok/bin/grok': '/home/u/.grok/downloads/grok-linux-x64' }))).toBe(true);
    expect(isGrokBuildBin('/home/u/.local/bin/grok', env, 'linux', fsx({ '/home/u/.local/bin/grok': '/home/u/.grok/downloads/grok-linux-x64' }))).toBe(true);
  });

  it('accepts $GROK_HOME when set, and the npm package (postinstall into $GROK_HOME/bin, or the package dir)', () => {
    expect(isGrokBuildBin('/x/grok', { HOME: '/home/u', GROK_HOME: '/opt/grok' }, 'linux', fsx({ '/x/grok': '/opt/grok/bin/grok-1.0.50' }))).toBe(true);
    expect(isGrokBuildBin('/usr/local/bin/grok', env, 'linux', fsx({ '/usr/local/bin/grok': '/usr/local/lib/node_modules/@xai-official/grok/bin/grok-native' }))).toBe(true);
    expect(isGrokBuildBin('/usr/local/bin/grok', env, 'linux', fsx({ '/usr/local/bin/grok': '/usr/local/lib/node_modules/@xai-official/grok-linux-x64/bin/grok' }))).toBe(true);
  });

  it('refuses any other `grok`: a community CLI, a look-alike scope or dir, a stray file, an unresolvable link', () => {
    expect(isGrokBuildBin('/usr/bin/grok', env, 'linux', fsx({ '/usr/bin/grok': '/usr/bin/grok' }))).toBe(false);
    expect(isGrokBuildBin('/usr/local/bin/grok', env, 'linux', fsx({ '/usr/local/bin/grok': '/usr/local/lib/node_modules/grok-dev/dist/grok' }))).toBe(false);
    expect(isGrokBuildBin('/usr/local/bin/grok', env, 'linux', fsx({ '/usr/local/bin/grok': '/usr/local/lib/node_modules/@xai-officia1/grok/bin/grok' }))).toBe(false);
    expect(isGrokBuildBin('/home/u/.grok-evil/bin/grok', env, 'linux', fsx({ '/home/u/.grok-evil/bin/grok': '/home/u/.grok-evil/bin/grok' }))).toBe(false);
    expect(isGrokBuildBin('/home/u/.grok/grok', env, 'linux', fsx({ '/home/u/.grok/grok': '/home/u/.grok/grok' }))).toBe(false);
    expect(isGrokBuildBin('/gone/grok', env, 'linux', fsx({}))).toBe(false);
  });

  it('win32: the installer\'s copy in %USERPROFILE%\\.grok\\bin, or npm\'s grok.cmd only beside the package', () => {
    const w = { USERPROFILE: 'C:\\Users\\u' };
    expect(isGrokBuildBin('C:\\Users\\u\\.grok\\bin\\grok.exe', w, 'win32', fsx({ 'C:\\Users\\u\\.grok\\bin\\grok.exe': 'C:\\Users\\u\\.grok\\bin\\grok.exe' }))).toBe(true);
    const cmd = 'C:\\Users\\u\\AppData\\Roaming\\npm\\grok.cmd';
    expect(isGrokBuildBin(cmd, w, 'win32', fsx({ [cmd]: cmd }, ['C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@xai-official\\grok\\package.json']))).toBe(true);
    expect(isGrokBuildBin(cmd, w, 'win32', fsx({ [cmd]: cmd }))).toBe(false);
  });

  it('grokHome: $GROK_HOME verbatim, else <home>/.grok', () => {
    expect(grokHome({ GROK_HOME: '/g' }, 'linux', '/home/u')).toBe('/g');
    expect(grokHome({}, 'linux', '/nonexistent-home-xyz')).toBe('/nonexistent-home-xyz/.grok');
  });
});

describe('buildGrokLaunch', () => {
  const BASE: GrokLaunchContext = { passthrough: [], present: false, overridden: [], configFile: '/home/u/.grok/config.toml' };
  const ctx = (over: Partial<GrokLaunchContext> = {}): GrokLaunchContext => ({ ...BASE, ...over });

  it('nothing present: one toml-mcp-entry write, no flags (no --trust), args untouched', () => {
    expect(buildGrokLaunch(ctx({ passthrough: ['-p', 'hi'] }))).toEqual({
      bin: 'grok', args: ['-p', 'hi'], env: { ALIGN_WRAPPED: '1' }, files: [],
      writes: [{ kind: 'toml-mcp-entry', file: '/home/u/.grok/config.toml', topKey: 'mcp_servers', name: 'align-local', entry: LOCAL }],
    });
  });
  it('present: no write; conflict: no write and one line', () => {
    expect(buildGrokLaunch(ctx({ present: true }))).not.toHaveProperty('writes');
    const spec = buildGrokLaunch(ctx({ conflict: '/r/.grok/config.toml' }));
    expect(spec).not.toHaveProperty('writes');
    expect(spec.notes).toEqual(['/r/.grok/config.toml defines its own align-local MCP server, so Align did not add its graph to Grok Build. Remove that entry to use the graph.']);
  });
});

describe('readGrokState and the TOML write (sandbox files)', () => {
  let root: string, home: string, proj: string, cfg: string;
  let manifest: Record<string, WrittenConfig>;
  let lines: string[];
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-grok-')));
    home = path.join(root, 'home');
    proj = path.join(root, 'repo', 'sub');
    mkdirSync(path.join(home, '.grok'), { recursive: true });
    mkdirSync(proj, { recursive: true });
    cfg = path.join(home, '.grok', 'config.toml');
    manifest = {};
    lines = [];
    setWriteRecorder((f, e) => { manifest[f] = mergeWrittenConfig(manifest[f], e); }, (f) => manifest[f]);
  });
  afterEach(() => { setWriteRecorder(undefined); rmSync(root, { recursive: true, force: true }); });
  const state = (env: Record<string, string> = {}) => readGrokState(proj, home, { localIsDefault: false }, env, 'linux');
  const W = (): ConfigWrite => ({ kind: 'toml-mcp-entry', file: cfg, topKey: 'mcp_servers', name: 'align-local', entry: LOCAL, root: home });
  const write = () => applyConfigWrite(W(), (l) => lines.push(l));
  const canonToml = '[mcp_servers.align-local]\ncommand = "align"\nargs = ["mcp", "--env", "local"]\n';

  it('state: the config file is $GROK_HOME/config.toml or ~/.grok/config.toml', () => {
    expect(state().configFile).toBe(cfg);
    expect(state({ GROK_HOME: path.join(root, 'g') }).configFile).toBe(path.join(root, 'g', 'config.toml'));
  });

  it('state: a canonical align-local or align in the user config.toml is present; a hostile one there is a conflict', () => {
    expect(state()).toMatchObject({ present: false });
    writeFileSync(cfg, canonToml);
    expect(state().present).toBe(true);
    writeFileSync(cfg, '[mcp_servers.align-local]\ncommand = "align"\nargs = ["mcp", "--env", "local"]\nenv = { PATH = "/evil" }\n');
    expect(state()).toMatchObject({ present: false, conflict: cfg });
  });

  it('state: a hostile align-local in a project .grok/config.toml up the tree is a conflict (it replaces the user\'s); a canonical one is not', () => {
    mkdirSync(path.join(root, 'repo', '.grok'));
    writeFileSync(path.join(root, 'repo', '.grok', 'config.toml'), '[mcp_servers.align-local]\ncommand = "evil"\n');
    expect(state().conflict).toBe(path.join(root, 'repo', '.grok', 'config.toml'));
    writeFileSync(path.join(root, 'repo', '.grok', 'config.toml'), canonToml);
    expect(state().conflict).toBeUndefined();
  });

  it('state: the user\'s --cwd moves the project scanned: clean cwd + --cwd <repo with a hostile .grok/config.toml> is a conflict', () => {
    const other = path.join(root, 'other');
    mkdirSync(path.join(other, '.grok'), { recursive: true });
    writeFileSync(path.join(other, '.grok', 'config.toml'), '[mcp_servers.align-local]\ncommand = "evil"\n');
    expect(state().conflict).toBeUndefined();
    expect(readGrokState(proj, home, { localIsDefault: false }, {}, 'linux', ['--cwd', other]).conflict).toBe(path.join(other, '.grok', 'config.toml'));
    expect(readGrokState(proj, home, { localIsDefault: false }, {}, 'linux', ['--cwd=../../other']).conflict).toBe(path.join(other, '.grok', 'config.toml'));
    expect(buildGrokLaunch({ passthrough: ['--cwd', other], ...readGrokState(proj, home, { localIsDefault: false }, {}, 'linux', ['--cwd', other]) })).not.toHaveProperty('writes');
  });

  it('state: a relative GROK_HOME is resolved, not left relative to wherever the write runs', () => {
    expect(path.isAbsolute(state({ GROK_HOME: 'rel/grok' }).configFile)).toBe(true);
    expect(grokHome({ GROK_HOME: 'rel' }, HOST, '/h')).toBe(path.resolve('rel'));
  });

  it('state: a local align imported from ~/.claude.json is present, unless [compat.claude] mcps = false', () => {
    writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { align: LOCAL } }));
    expect(state().present).toBe(true);
    writeFileSync(cfg, '[compat.claude]\nmcps = false\n');
    expect(state().present).toBe(false);
  });

  it('state: a hostile align-local in a repo .mcp.json is no conflict (config.toml wins over it, measured)', () => {
    writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'align-local': { command: 'evil' } } }));
    expect(state()).toMatchObject({ present: false });
    expect(state().conflict).toBeUndefined();
  });

  it('write: appends the table once in a marked block, keeping the user\'s comments and tables byte for byte', () => {
    const original = '# my grok config\n[mcp_servers.mine]\ncommand = "x" # keep me\n';
    writeFileSync(cfg, original);
    write();
    const after = readFileSync(cfg, 'utf8');
    expect(after.startsWith(original)).toBe(true);
    expect(after.slice(original.length)).toBe('\n# >>> align-local: added by align (undo: align use --undo)\n[mcp_servers.align-local]\ncommand = "align"\nargs = ["mcp", "--env", "local"]\n# <<< align-local\n');
    lines.length = 0;
    write();
    expect(readFileSync(cfg, 'utf8')).toBe(after);
    expect(lines).toEqual([]);
  });

  it('write: a missing config.toml is created holding only the block; undo removes it', () => {
    write();
    expect(readFileSync(cfg, 'utf8')).toContain('[mcp_servers.align-local]');
    expect(undoWrittenConfigs(manifest).removed).toEqual([cfg]);
    expect(existsSync(cfg)).toBe(false);
  });

  it('undo restores an existing config.toml byte for byte (sha256), a file without a trailing newline too', () => {
    const original = '# mine\nmodel = "grok-4"\n[mcp_servers.mine]\ncommand = "x"';
    writeFileSync(cfg, original);
    write();
    expect(sha(readFileSync(cfg, 'utf8'))).not.toBe(sha(original));
    expect(undoWrittenConfigs(manifest).restored).toEqual([cfg]);
    expect(sha(readFileSync(cfg, 'utf8'))).toBe(sha(original));
  });

  it('undo after the user edited the file takes out only align\'s block', () => {
    writeFileSync(cfg, 'model = "a"\n');
    write();
    writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}\n[mcp_servers.later]\ncommand = "y"\n`);
    expect(undoWrittenConfigs(manifest).cleaned).toEqual([cfg]);
    const left = readFileSync(cfg, 'utf8');
    expect(left).not.toContain('align-local');
    expect(left).toContain('[mcp_servers.later]');
    expect(left).toContain('model = "a"');
  });

  it('refuses, and writes nothing, for invalid TOML or an inline mcp_servers table it cannot extend', () => {
    for (const text of ['model = = "x"\n', 'mcp_servers = { mine = { command = "x" } }\n']) {
      writeFileSync(cfg, text);
      expect(() => write()).toThrow(/left (it|the file) alone/);
      expect(readFileSync(cfg, 'utf8')).toBe(text);
    }
  });

  // What `grok mcp add later -- echo` (grok 1.0.50) leaves after align's write: it re-serialises
  // config.toml, dropping every comment, align's markers included, and reflowing arrays.
  const grokRewrite = (alignArgs = '[\n    "mcp",\n    "--env",\n    "local",\n]') =>
    `[mcp_servers.user_own]\ncommand = "echo"\n\n[mcp_servers.align-local]\ncommand = "align"\nargs = ${alignArgs}\n\n[mcp_servers.later]\ncommand = "echo"\nargs = []\nenabled = true\n`;

  it('undo after Grok rewrote the file (markers gone, table still canonical): takes out only that table', () => {
    writeFileSync(cfg, '# my comment\n[mcp_servers.user_own]\ncommand = "echo"\n');
    write();
    writeFileSync(cfg, grokRewrite());
    const report = undoWrittenConfigs(manifest);
    expect(report).toMatchObject({ cleaned: [cfg], skipped: [] });
    expect(readFileSync(cfg, 'utf8')).toBe('[mcp_servers.user_own]\ncommand = "echo"\n\n[mcp_servers.later]\ncommand = "echo"\nargs = []\nenabled = true\n');
    expect(existsSync(`${cfg}.align-backup`)).toBe(false);
  });

  it('marker-less undo never cuts a comment the user placed after align\'s table: skipped, record and backup kept', () => {
    writeFileSync(cfg, '# my comment\n[mcp_servers.user_own]\ncommand = "echo"\n');
    write();
    const withNote = grokRewrite().replace('[mcp_servers.later]', '# keep this note\n[mcp_servers.later]');
    writeFileSync(cfg, withNote);
    const report = undoWrittenConfigs(manifest);
    expect(report.cleaned).toEqual([]);
    expect(report.done).toEqual([]);
    expect(report.skipped.join('\n')).toContain('[mcp_servers.align-local]');
    expect(readFileSync(cfg, 'utf8')).toBe(withNote);
    expect(existsSync(`${cfg}.align-backup`)).toBe(true);
  });

  it('marker-less undo also skips when blank lines sit inside align\'s table or more than one follows it', () => {
    for (const mangle of [(t: string) => t.replace('command = "align"\n', 'command = "align"\n\n'), (t: string) => t.replace('\n\n[mcp_servers.later]', '\n\n\n[mcp_servers.later]')]) {
      for (const k of Object.keys(manifest)) delete manifest[k];
      writeFileSync(cfg, '[mcp_servers.user_own]\ncommand = "echo"\n');
      try { rmSync(`${cfg}.align-backup`); } catch { /* none */ }
      write();
      const text = mangle(grokRewrite());
      writeFileSync(cfg, text);
      expect(undoWrittenConfigs(manifest).cleaned).toEqual([]);
      expect(readFileSync(cfg, 'utf8')).toBe(text);
    }
  });

  it('undo after Grok rewrote the file AND align-local was changed: skipped, record and backup kept, says what to remove', () => {
    writeFileSync(cfg, '# my comment\n[mcp_servers.user_own]\ncommand = "echo"\n');
    write();
    const changed = grokRewrite('["mcp", "--env", "prod"]');
    writeFileSync(cfg, changed);
    const report = undoWrittenConfigs(manifest);
    expect(report.cleaned).toEqual([]);
    expect(report.done).toEqual([]);
    expect(report.skipped.join('\n')).toContain('[mcp_servers.align-local]');
    expect(readFileSync(cfg, 'utf8')).toBe(changed);
    expect(existsSync(`${cfg}.align-backup`)).toBe(true);
  });

  it('a marked block that is gone from a file with no table record is skipped, never reported cleaned', () => {
    writeFileSync(cfg, 'model = "a"\n');
    write();
    delete manifest[cfg]!.block!.table;
    writeFileSync(cfg, grokRewrite());
    const report = undoWrittenConfigs(manifest);
    expect(report.cleaned).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toContain('# >>> align-local');
    expect(existsSync(`${cfg}.align-backup`)).toBe(true);
  });

  it('refuses to write (one line, no write, no record) into a file already holding an align marker', () => {
    for (const stale of ['# >>> align-local: added by align (undo: align use --undo)\n', '# <<< align-local\n']) {
      const text = `[mcp_servers.user_own]\ncommand = "echo"\n\n${stale}[mcp_servers.other]\ncommand = "keepme"\n`;
      writeFileSync(cfg, text);
      expect(() => write()).toThrow(/marker/);
      expect(readFileSync(cfg, 'utf8')).toBe(text);
      expect(manifest[cfg]).toBeUndefined();
    }
  });

  it('a block whose start marker appears twice is ambiguous: undo never pairs across it, the user\'s table between them survives', () => {
    writeFileSync(cfg, 'model = "a"\n');
    write();
    const { start } = { start: '# >>> align-local: added by align (undo: align use --undo)' };
    const text = `${start}\n[mcp_servers.other]\ncommand = "keepme"\n\n${readFileSync(cfg, 'utf8')}`;
    writeFileSync(cfg, text);
    undoWrittenConfigs(manifest);
    const left = readFileSync(cfg, 'utf8');
    expect(left).toContain('[mcp_servers.other]\ncommand = "keepme"');
    expect(left).toContain('model = "a"');
  });

  it('never writes through a symlinked config.toml', () => {
    const target = path.join(root, 'elsewhere.toml');
    writeFileSync(target, 'model = "x"\n');
    symlinkSync(target, cfg);
    write();
    expect(readFileSync(target, 'utf8')).toBe('model = "x"\n');
    expect(lines.some((l) => l.includes('symlink'))).toBe(true);
  });
});
