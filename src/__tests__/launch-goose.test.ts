import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGooseLaunch } from '../lib/launch/adapters/goose.js';
import { gooseAlignLocal, gooseConfigFile, isGooseBin, readGooseState } from '../lib/launch/goose-state.js';

/*
 * Goose, per session (goose 1.54.0, binary-verified in a sandbox): `goose session
 * --with-extension '[name:]command args...'` adds a stdio extension for that session and the
 * user's own extensions still load. Both checked by running `goose run` (the same flag) against a
 * stub model: its request carried user_own's tool AND align-local's. An ENABLED same-named
 * extension in config.yaml makes goose refuse to start ("extension name 'align-local' is already
 * in use"), a disabled one does not, so the reader must find one before Align adds its own.
 */
const EXT = 'align-local:align mcp --env local';
const O = { localIsDefault: false, platform: 'linux' };

let root: string, home: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'align-goose-')));
  home = path.join(root, 'home');
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('gooseConfigFile: where goose reads config.yaml (goose info, 1.54.0)', () => {
  it('GOOSE_PATH_ROOT/config/config.yaml wins, else $XDG_CONFIG_HOME/goose, else ~/.config/goose', () => {
    expect(gooseConfigFile('/home/u', { GOOSE_PATH_ROOT: '/r', XDG_CONFIG_HOME: '/x' }, 'linux')).toBe('/r/config/config.yaml');
    expect(gooseConfigFile('/home/u', { XDG_CONFIG_HOME: '/x' }, 'linux')).toBe('/x/goose/config.yaml');
    expect(gooseConfigFile('/home/u', {}, 'linux')).toBe('/home/u/.config/goose/config.yaml');
    expect(gooseConfigFile('/Users/u', {}, 'darwin')).toBe('/Users/u/.config/goose/config.yaml');
  });
  it('win32: %APPDATA%\\Block\\goose\\config\\config.yaml (goose docs, config files guide)', () => {
    expect(gooseConfigFile('C:\\Users\\u', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32')).toBe('C:\\Users\\u\\AppData\\Roaming\\Block\\goose\\config\\config.yaml');
  });
});

const block = (lines: string[]) => ['GOOSE_PROVIDER: openai', 'extensions:', '  user_own:', '    enabled: true', '    cmd: /bin/u', '    args: []', '    type: stdio', ...lines, 'GOOSE_MODEL: x', ''].join('\n');

describe('gooseAlignLocal: does config.yaml already hold an align-local extension', () => {
  it('absent: no file, or a file that never names align-local (two examples)', () => {
    expect(gooseAlignLocal(null, O)).toBe('absent');
    expect(gooseAlignLocal(block([]), O)).toBe('absent');
  });
  it('a name in a comment only is absent', () => {
    expect(gooseAlignLocal(block(['  # align-local: removed']), O)).toBe('absent');
  });
  it('present: an enabled align-local running `align mcp --env local` (flow and block args)', () => {
    expect(gooseAlignLocal(block(['  align-local:', '    enabled: true', '    type: stdio', '    name: align-local', '    cmd: align', '    args: [mcp, --env, local]', '    timeout: 300']), O)).toBe('present');
    expect(gooseAlignLocal(block(['  align-local:', '    enabled: true', '    cmd: align', '    args:', '    - mcp', '    - "--env"', "    - 'local'"]), O)).toBe('present');
  });
  it('a bare `align mcp` is ours only where a bare `align mcp` reads the local graph', () => {
    const t = block(['  align-local:', '    enabled: true', '    cmd: align', '    args: [mcp]']);
    expect(gooseAlignLocal(t, { ...O, localIsDefault: true })).toBe('present');
    expect(gooseAlignLocal(t, O)).toBe('conflict');
  });
  it('conflict: an enabled align-local running anything else, or carrying a key that could change what runs', () => {
    expect(gooseAlignLocal(block(['  align-local:', '    enabled: true', '    cmd: /tmp/evil', '    args: []']), O)).toBe('conflict');
    expect(gooseAlignLocal(block(['  align-local:', '    enabled: true', '    cmd: align', '    args: [mcp, --env, local]', '    envs:', '      ALIGN_ENV: prod']), O)).toBe('conflict');
  });
  it('a canonical extension named `align` counts as present (no second copy); a non-canonical `align` is not ours and blocks nothing', () => {
    expect(gooseAlignLocal(block(['  align:', '    enabled: true', '    type: stdio', '    cmd: align', '    args: [mcp, --env, local]']), O)).toBe('present');
    expect(gooseAlignLocal(block(['  align:', '    enabled: true', '    cmd: align', '    args: [mcp, --env, prod]']), O)).toBe('absent');
    expect(gooseAlignLocal(block(['  align:', '    enabled: false', '    cmd: align', '    args: [mcp, --env, local]']), O)).toBe('absent');
  });
  it('a DISABLED align-local is absent: goose only refuses a clash with an enabled one', () => {
    expect(gooseAlignLocal(block(['  align-local:', '    enabled: false', '    cmd: /tmp/evil', '    args: []']), O)).toBe('absent');
  });
  it('a mention align cannot place (a flow map, a `name:` under another key) is a conflict, never a guess', () => {
    expect(gooseAlignLocal('extensions: {align-local: {cmd: x}}\n', O)).toBe('conflict');
    expect(gooseAlignLocal(block(['  other:', '    enabled: true', '    name: align-local', '    cmd: x']), O)).toBe('conflict');
  });
  it('win32: the canonical command is cmd /c align', () => {
    const t = block(['  align-local:', '    enabled: true', '    cmd: cmd', '    args: [/c, align, mcp, --env, local]']);
    expect(gooseAlignLocal(t, { ...O, platform: 'win32' })).toBe('present');
    expect(gooseAlignLocal(t, O)).toBe('conflict');
  });
});

describe('readGooseState', () => {
  // The sandbox home is a host path; on Windows goose reads %APPDATA%, covered above.
  it.skipIf(process.platform === 'win32')('reads the config file goose reads, and reports a clash with the file named', () => {
    const f = path.join(home, '.config', 'goose', 'config.yaml');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, block(['  align-local:', '    enabled: true', '    cmd: /tmp/evil', '    args: []']));
    expect(readGooseState(root, home, { localIsDefault: false }, {}, process.platform)).toEqual({ present: false, conflict: f, configFile: f });
    writeFileSync(f, block([]));
    expect(readGooseState(root, home, { localIsDefault: false }, {}, process.platform)).toEqual({ present: false, configFile: f });
  });
});

describe('buildGooseLaunch: `goose session --with-extension`', () => {
  const base = { present: false, configFile: '/c/config.yaml' };
  it('no args: opens `goose session` with align-local added, and ALIGN_WRAPPED', () => {
    expect(buildGooseLaunch({ ...base, passthrough: [] })).toEqual({ bin: 'goose', args: ['session', '--with-extension', EXT], env: { ALIGN_WRAPPED: '1' }, files: [] });
  });
  it('session options in the user args: session first, then the extension, then theirs (two examples)', () => {
    expect(buildGooseLaunch({ ...base, passthrough: ['--resume'] }).args).toEqual(['session', '--with-extension', EXT, '--resume']);
    expect(buildGooseLaunch({ ...base, passthrough: ['-n', 'work', '--debug'] }).args).toEqual(['session', '--with-extension', EXT, '-n', 'work', '--debug']);
  });
  it('the user named `session` (or its alias `s`) themselves: the extension goes right after it', () => {
    expect(buildGooseLaunch({ ...base, passthrough: ['session', '--resume'] }).args).toEqual(['session', '--with-extension', EXT, '--resume']);
    expect(buildGooseLaunch({ ...base, passthrough: ['s'] }).args).toEqual(['s', '--with-extension', EXT]);
  });
  it('a session SUBcommand (`session list`) is left alone: it opens no chat', () => {
    expect(buildGooseLaunch({ ...base, passthrough: ['session', 'list'] }).args).toEqual(['session', 'list']);
  });
  it('`goose run` takes the same flag (the form verified against a stub model): the extension goes right after `run`', () => {
    expect(buildGooseLaunch({ ...base, passthrough: ['run', '-t', 'hi'] }).args).toEqual(['run', '--with-extension', EXT, '-t', 'hi']);
    expect(buildGooseLaunch({ ...base, passthrough: ['run', '--recipe', 'r.yaml'] }).args).toEqual(['run', '--with-extension', EXT, '--recipe', 'r.yaml']);
  });
  it('another subcommand is left alone with one note; root --help/--version are left alone silently', () => {
    const run = buildGooseLaunch({ ...base, passthrough: ['configure'] });
    expect(run.args).toEqual(['configure']);
    expect(run.notes).toEqual(["Align adds its graph to `goose session` and `goose run` only, so `goose configure` opens without it."]);
    expect(buildGooseLaunch({ ...base, passthrough: ['--help'] })).toEqual({ bin: 'goose', args: ['--help'], env: { ALIGN_WRAPPED: '1' }, files: [] });
    expect(buildGooseLaunch({ ...base, passthrough: ['-V'] }).args).toEqual(['-V']);
  });
  it('canonical align-local already in config.yaml: nothing added, no duplicate', () => {
    expect(buildGooseLaunch({ ...base, present: true, passthrough: [] })).toEqual({ bin: 'goose', args: [], env: { ALIGN_WRAPPED: '1' }, files: [] });
  });
  it('a clash: nothing added (goose would refuse to start), one line naming the file', () => {
    const s = buildGooseLaunch({ ...base, conflict: '/c/config.yaml', passthrough: ['--resume'] });
    expect(s.args).toEqual(['--resume']);
    expect(s.notes).toEqual(["/c/config.yaml defines its own align-local extension, so Align did not add its graph to Goose. Remove or rename that entry to use the graph."]);
  });
  it('never writes the user\'s config, and passes no approval flag', () => {
    const s = buildGooseLaunch({ ...base, passthrough: [] });
    expect(s.writes).toBeUndefined();
    expect(s.args.join(' ')).not.toMatch(/--no-profile|approve|yolo|--with-builtin/);
  });
});

/*
 * `goose` is also pressly/goose, a common Go database-migration CLI; Homebrew ships both
 * (formula `goose` is pressly's, `block-goose-cli` is Block's, both install bin/goose). So a
 * `goose` counts only from Block's documented install places: the installer's $GOOSE_BIN_DIR
 * (download_cli.sh: default ~/.local/bin; %USERPROFILE%\goose on Windows) or Homebrew's
 * Cellar/block-goose-cli. Judged on the real path, so a link in ~/.local/bin to pressly's does not pass.
 */
describe('isGooseBin: only Block\'s goose, never pressly\'s migration tool', () => {
  const touch = (f: string) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, ''); return f; };
  const env = () => ({ HOME: home });
  it.skipIf(process.platform === 'win32')('the installer\'s default ~/.local/bin, and a $GOOSE_BIN_DIR, are Block\'s', () => {
    expect(isGooseBin(touch(path.join(home, '.local', 'bin', 'goose')), env(), 'linux')).toBe(true);
    const custom = touch(path.join(root, 'opt', 'goose-bin', 'goose'));
    expect(isGooseBin(custom, { ...env(), GOOSE_BIN_DIR: path.dirname(custom) }, 'linux')).toBe(true);
    expect(isGooseBin(custom, env(), 'linux')).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('pressly\'s usual places are not: `go install` (~/go/bin) and /usr/local/bin', () => {
    expect(isGooseBin(touch(path.join(home, 'go', 'bin', 'goose')), env(), 'linux')).toBe(false);
    expect(isGooseBin(touch(path.join(root, 'usr', 'local', 'bin', 'goose')), env(), 'linux')).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('Homebrew: a bin/goose resolving into Cellar/block-goose-cli is Block\'s; into Cellar/goose (pressly) it is not', () => {
    const block = touch(path.join(root, 'brew', 'Cellar', 'block-goose-cli', '1.54.0', 'bin', 'goose'));
    const pressly = touch(path.join(root, 'brew2', 'Cellar', 'goose', '3.28.0', 'bin', 'goose'));
    mkdirSync(path.join(root, 'brew', 'bin'), { recursive: true });
    mkdirSync(path.join(root, 'brew2', 'bin'), { recursive: true });
    symlinkSync(block, path.join(root, 'brew', 'bin', 'goose'));
    symlinkSync(pressly, path.join(root, 'brew2', 'bin', 'goose'));
    expect(isGooseBin(path.join(root, 'brew', 'bin', 'goose'), env(), 'darwin')).toBe(true);
    expect(isGooseBin(path.join(root, 'brew2', 'bin', 'goose'), env(), 'darwin')).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('a link in ~/.local/bin pointing at pressly\'s goose elsewhere is not Block\'s', () => {
    const pressly = touch(path.join(home, 'go', 'bin', 'goose'));
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(pressly, path.join(home, '.local', 'bin', 'goose'));
    expect(isGooseBin(path.join(home, '.local', 'bin', 'goose'), env(), 'linux')).toBe(false);
  });
  it('win32: %USERPROFILE%\\goose\\goose.exe is Block\'s; a go\\bin goose.exe is not', () => {
    const w = { USERPROFILE: 'C:\\Users\\u' };
    expect(isGooseBin('C:\\Users\\u\\goose\\goose.exe', w, 'win32')).toBe(true);
    expect(isGooseBin('C:\\Users\\u\\go\\bin\\goose.exe', w, 'win32')).toBe(false);
  });
});
