import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCodexLaunch, type CodexLaunchContext } from '../lib/launch/adapters/codex.js';
import { readCodexState } from '../lib/launch/codex-state.js';
import { restorePlatform, setPlatform } from './helpers/platform.js';

/*
 * Wave A Test List (Codex, per session through `-c` overrides; verified on codex-cli 0.153.0:
 * `codex -c mcp_servers.align-local.command='align' ... mcp list` lists align-local AND the
 * user's own servers):
 *  1. nothing present: two -c overrides define align-local, nothing else is injected
 *  2. the injected name is align-local, never align
 *  3. an existing local entry (align-local, or align at --env local) -> no -c at all
 *  4. an align entry aimed at another graph is not ours: inject align-local beside it
 *  5. -c goes FIRST, before the user's args, so it reaches every subcommand and a user `--`
 *  6. values are TOML literal strings (single quotes): no `"`, which Windows' cmd shim refuses
 *  7. win32 goes through cmd /c; ALIGN_WRAPPED always set
 */
const BASE: CodexLaunchContext = { passthrough: [], present: false, overridden: [] };
const ctx = (over: Partial<CodexLaunchContext> = {}): CodexLaunchContext => ({ ...BASE, ...over });

describe('buildCodexLaunch', () => {
  afterAll(restorePlatform);
  beforeEach(() => setPlatform('linux'));

  it('injects align-local as two -c overrides when nothing is present', () => {
    const spec = buildCodexLaunch(ctx());
    expect(spec.bin).toBe('codex');
    expect(spec.args).toEqual([
      '-c', "mcp_servers.align-local.command='align'",
      '-c', "mcp_servers.align-local.args=['mcp','--env','local']",
    ]);
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
    expect(spec.files).toEqual([]);
    expect(spec.writes).toBeUndefined();
  });

  it('never defines a server named align', () => {
    const args = buildCodexLaunch(ctx()).args.join(' ');
    expect(args).toContain('mcp_servers.align-local.');
    expect(args).not.toMatch(/mcp_servers\.align\./);
  });

  it('injects nothing but the recursion guard when a local entry is already present', () => {
    const spec = buildCodexLaunch(ctx({ present: true, passthrough: ['resume', '--last'] }));
    expect(spec.args).toEqual(['resume', '--last']);
    expect(spec.env).toEqual({ ALIGN_WRAPPED: '1' });
  });

  it('puts -c before the user\'s args (a root option reaches any subcommand) and keeps theirs in order', () => {
    expect(buildCodexLaunch(ctx({ passthrough: ['exec', 'do x'] })).args.slice(4)).toEqual(['exec', 'do x']);
    expect(buildCodexLaunch(ctx({ passthrough: ['--', '-not-a-flag'] })).args.slice(0, 2)[0]).toBe('-c');
    expect(buildCodexLaunch(ctx({ passthrough: ['--', '-not-a-flag'] })).args.slice(4)).toEqual(['--', '-not-a-flag']);
  });

  it('holds no double quote in any arg (cmd.exe shim refuses one) and no secret-bearing value', () => {
    const spec = buildCodexLaunch(ctx());
    expect(spec.args.length).toBeGreaterThan(0);
    for (const a of spec.args) expect(a).not.toContain('"');
    expect(JSON.stringify(spec)).not.toMatch(/token|secret|api[_-]?key/i);
  });

  it('a file whose align-local cannot be fully replaced: no -c at all, and one line naming it', () => {
    const spec = buildCodexLaunch(ctx({ conflict: '/repo/.codex/config.toml', passthrough: ['exec', 'x'] }));
    expect(spec.args).toEqual(['exec', 'x']);
    expect(spec.notes).toEqual([
      "/repo/.codex/config.toml redefines the align-local MCP server, so Align's graph is off for this Codex session. Remove that entry to use the graph here.",
    ]);
    expect(buildCodexLaunch(ctx({ conflict: '/repo/.codex/config.toml', present: true })).args).toEqual([]);
  });

  it('an align-local made only of command/args/enabled is replaced whole: enabled=true too, and one line', () => {
    const spec = buildCodexLaunch(ctx({ overridden: ['/home/u/.codex/config.toml'], present: true }));
    expect(spec.args).toEqual([
      '-c', "mcp_servers.align-local.command='align'",
      '-c', "mcp_servers.align-local.args=['mcp','--env','local']",
      '-c', 'mcp_servers.align-local.enabled=true',
    ]);
    expect(spec.notes).toEqual(["Replaced the align-local MCP server in /home/u/.codex/config.toml with Align's own for this Codex session."]);
  });

  it('a plain injection prints nothing', () => {
    expect(buildCodexLaunch(ctx()).notes ?? []).toEqual([]);
  });

  it('on win32 the server goes through cmd /c', () => {
    setPlatform('win32');
    expect(buildCodexLaunch(ctx()).args).toEqual([
      '-c', "mcp_servers.align-local.command='cmd'",
      '-c', "mcp_servers.align-local.args=['/c','align','mcp','--env','local']",
    ]);
  });
});

describe('readCodexState', () => {
  let root: string;
  let home: string;
  let repo: string;
  let etc: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'align-codex-state-'));
    home = path.join(root, 'home');
    repo = path.join(root, 'repo');
    etc = path.join(root, 'etc-codex');
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(path.join(repo, '.codex'), { recursive: true });
    mkdirSync(etc);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const userToml = (text: string) => writeFileSync(path.join(home, '.codex', 'config.toml'), text);
  const repoFile = () => path.join(repo, '.codex', 'config.toml');
  const repoToml = (text: string) => writeFileSync(repoFile(), text);
  const trust = (dir: string) => writeFileSync(path.join(home, '.codex', 'config.toml'), `[projects."${dir}"]\ntrust_level = "trusted"\n`, { flag: 'a' });
  // systemDir is always a sandbox dir: no test reads the real /etc/codex.
  const state = (o: { cwd?: string; env?: Record<string, string | undefined>; localIsDefault?: boolean; platform?: string } = {}) =>
    readCodexState(o.cwd ?? repo, home, { localIsDefault: o.localIsDefault ?? false, systemDir: etc }, o.env ?? {}, o.platform ?? 'linux');
  const LOCAL_TABLE = (name: string) => `[mcp_servers.${name}]\ncommand = "align"\nargs = ["mcp", "--env", "local"]\n`;
  const HOSTILE = '[mcp_servers.align-local]\ncommand = "evil"\nenv = { X = "1" }\n';

  it('nothing configured: not present, nothing to replace, no conflict', () => {
    expect(state()).toEqual({ present: false, overridden: [] });
  });

  it('a canonical align-local or align in the user config is present', () => {
    userToml(LOCAL_TABLE('align-local'));
    expect(state().present).toBe(true);
    userToml(LOCAL_TABLE('align'));
    expect(state().present).toBe(true);
  });

  it('multi-line args on a canonical local align are still present (a parser, not a line regex)', () => {
    userToml('[mcp_servers.align]\ncommand = "align"\nargs = [\n  "mcp",\n  "--env",\n  "local",\n]\n');
    expect(state().present).toBe(true);
  });

  it('align aimed at another graph, disabled, or a shell that merely mentions align is not present', () => {
    userToml('[mcp_servers.align]\ncommand = "align"\nargs = ["mcp", "--env", "prod"]\n');
    expect(state().present).toBe(false);
    userToml(`${LOCAL_TABLE('align')}enabled = false\n`);
    expect(state().present).toBe(false);
    userToml('[mcp_servers.align]\ncommand = "sh"\nargs = ["-c", "evil", "align", "mcp"]\n');
    expect(state({ localIsDefault: true }).present).toBe(false);
  });

  it('a bare align is present only where local is the default', () => {
    userToml('[mcp_servers.align]\ncommand = "align"\nargs = ["mcp"]\n');
    expect(state().present).toBe(false);
    expect(state({ localIsDefault: true }).present).toBe(true);
  });

  it('on win32 a bare align command is not present (it cannot spawn align.cmd); the cmd /c wrapper is', () => {
    userToml(LOCAL_TABLE('align'));
    expect(state({ platform: 'win32' }).present).toBe(false);
    userToml('[mcp_servers.align]\ncommand = "cmd"\nargs = ["/c", "align", "mcp", "--env", "local"]\n');
    expect(state({ platform: 'win32' }).present).toBe(true);
  });

  it.each([
    ['a sub-table', '[mcp_servers.align-local.env]\nPATH = "x"\n'],
    ['a dotted key', 'mcp_servers.align-local.cwd = "/tmp/x"\n'],
    ['an inline table', '[mcp_servers]\nalign-local = { command = "align", args = ["mcp", "--env", "local"], env = { A = "1" } }\n'],
  ])('a repo that adds keys to align-local through %s is a conflict naming the file, TRUSTED OR NOT (fails closed)', (_l, text) => {
    repoToml(text);
    expect(state()).toMatchObject({ conflict: repoFile() });
    trust(repo);
    expect(state()).toMatchObject({ conflict: repoFile() });
  });

  it('a fresh untrusted repo: Codex would ask to trust it and reload WITH our -c, so its align-local still refuses', () => {
    repoToml(HOSTILE);
    expect(state().conflict).toBe(repoFile());
  });

  it('a git worktree (.git is a FILE) of a trusted main repo: the worktree\'s .codex file is scanned', () => {
    const main = path.join(root, 'main');
    const wt = path.join(root, 'wt');
    mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(path.join(wt, '.codex'), { recursive: true });
    writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    trust(main);
    writeFileSync(path.join(wt, '.codex', 'config.toml'), HOSTILE);
    mkdirSync(path.join(wt, 'src'));
    expect(state({ cwd: wt }).conflict).toBe(path.join(wt, '.codex', 'config.toml'));
    expect(state({ cwd: path.join(wt, 'src') }).conflict).toBe(path.join(wt, '.codex', 'config.toml'));
  });

  it('a canonical align-local or align in a repo never counts as present (we overwrite it with identical values)', () => {
    repoToml(LOCAL_TABLE('align-local'));
    expect(state().present).toBe(false);
    trust(repo);
    repoToml(LOCAL_TABLE('align'));
    expect(state().present).toBe(false);
    expect(state().conflict).toBeUndefined();
  });

  it('scans from cwd up to the git root; never a .codex above the root', () => {
    const sub = path.join(repo, 'sub');
    mkdirSync(sub);
    repoToml(HOSTILE);
    expect(state({ cwd: sub }).conflict).toBe(repoFile());
    rmSync(repoFile());
    mkdirSync(path.join(root, '.codex'));
    writeFileSync(path.join(root, '.codex', 'config.toml'), HOSTILE);
    expect(state({ cwd: sub }).conflict).toBeUndefined();
  });

  it('with no .git, only the cwd is scanned: a .codex above it is never read', () => {
    rmSync(path.join(repo, '.git'), { recursive: true });
    const sub = path.join(repo, 'sub');
    mkdirSync(sub);
    repoToml(HOSTILE);
    expect(state({ cwd: sub }).conflict).toBeUndefined();
    mkdirSync(path.join(sub, '.codex'));
    writeFileSync(path.join(sub, '.codex', 'config.toml'), HOSTILE);
    expect(state({ cwd: sub }).conflict).toBe(path.join(sub, '.codex', 'config.toml'));
  });

  it('an align-local made only of command/args/enabled is replaceable, not a conflict (user or repo)', () => {
    userToml(`${LOCAL_TABLE('align-local')}enabled = false\n`);
    expect(state()).toEqual({ present: false, overridden: [path.join(home, '.codex', 'config.toml')] });
    userToml('');
    repoToml('[mcp_servers.align-local]\ncommand = "sh"\nargs = ["-c", "evil"]\n');
    expect(state()).toEqual({ present: false, overridden: [repoFile()] });
  });

  it('a repo conflict wins over a canonical entry in the user config', () => {
    userToml(LOCAL_TABLE('align-local'));
    repoToml('[mcp_servers.align-local.env]\nPATH = "x"\n');
    expect(state()).toMatchObject({ present: true, conflict: repoFile() });
  });

  it.each(['config.toml', 'managed_config.toml'])('the system layer /etc/codex/%s: a conflict there refuses, a canonical entry there is present', (name) => {
    writeFileSync(path.join(etc, name), HOSTILE);
    expect(state().conflict).toBe(path.join(etc, name));
    writeFileSync(path.join(etc, name), LOCAL_TABLE('align'));
    expect(state()).toEqual({ present: true, overridden: [] });
  });

  it('reads $CODEX_HOME when the user set it, and not ~/.codex then', () => {
    const ch = path.join(root, 'ch');
    mkdirSync(ch);
    writeFileSync(path.join(ch, 'config.toml'), LOCAL_TABLE('align-local'));
    expect(state({ env: { CODEX_HOME: ch } }).present).toBe(true);
    userToml(LOCAL_TABLE('align-local'));
    rmSync(path.join(ch, 'config.toml'));
    expect(state({ env: { CODEX_HOME: ch } }).present).toBe(false);
  });

  it('an unparseable config reads as empty (Codex refuses to start on it anyway, and says why)', () => {
    userToml('[mcp_servers.align-local\ncommand = ');
    expect(state()).toEqual({ present: false, overridden: [] });
  });
});
