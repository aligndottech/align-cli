import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderTrust, rememberAlignTrust, repoHasHarness } from '../lib/agent/trusted-folder.js';

let root: string;
let home: string;
let repo: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'align-trust-')));
  home = join(root, 'home');
  repo = join(root, 'work', 'widgets');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const claudeJson = (projects: Record<string, unknown>, dir = home): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ projects }));
};
const yes = { hasTrustDialogAccepted: true };
const alignDir = (): string => join(home, '.align');
const verdict = (cwd: string, env: Record<string, string | undefined> = {}) => folderTrust(cwd, { home, env, platform: process.platform, alignDir: alignDir() });
const trustedDir = (cwd: string, _home: string, env: Record<string, string | undefined>): string | undefined => verdict(cwd, env)?.dir;
const isTrusted = (cwd: string, env: Record<string, string | undefined> = {}): boolean => trustedDir(cwd, home, env) !== undefined;
const write = (file: string, text: string): void => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };

describe('trustedDir', () => {
  it('returns the exact folder the user accepted', () => {
    claudeJson({ [repo]: yes });
    expect(trustedDir(repo, home, {})).toBe(repo);
  });
  it('is undefined for a folder that is not in the file, or a key that does not exist on disk', () => {
    claudeJson({ [join(root, 'work', 'other')]: yes, [join(root, 'gone')]: yes });
    expect(trustedDir(repo, home, {})).toBeUndefined();
  });
  it('returns the trusted repo root for a subfolder', () => {
    claudeJson({ [repo]: yes });
    expect(trustedDir(join(repo, 'packages', 'api'), home, {})).toBe(repo);
  });
  it('returns the folder that matched, not the git root, when only a subfolder is trusted', () => {
    const sub = join(repo, 'packages', 'api');
    claudeJson({ [sub]: yes });
    expect(trustedDir(sub, home, {})).toBe(sub);
    expect(trustedDir(repo, home, {})).toBeUndefined();
  });
  it('does not trust a parent above the repo root', () => {
    claudeJson({ [join(root, 'work')]: yes });
    expect(isTrusted(repo)).toBe(false);
  });
  it('a folder with no .git under a trusted parent is not trusted', () => {
    const plain = join(root, 'plain', 'inner');
    mkdirSync(plain, { recursive: true });
    claudeJson({ [join(root, 'plain')]: yes });
    expect(isTrusted(plain)).toBe(false);
  });
  it('a .git FILE (worktree or submodule) stops the walk like a .git folder', () => {
    const wt = join(root, 'work', 'worktree');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere\n');
    claudeJson({ [join(root, 'work')]: yes });
    expect(isTrusted(join(wt, 'src'))).toBe(false);
    claudeJson({ [wt]: yes });
    expect(isTrusted(join(wt, 'src'))).toBe(true);
  });
  it('never counts the home directory, even when it holds .git and is listed', () => {
    mkdirSync(join(home, '.git'), { recursive: true });
    const inner = join(home, 'scratch');
    mkdirSync(inner);
    claudeJson({ [home]: yes });
    expect(isTrusted(inner)).toBe(false);
    expect(isTrusted(home)).toBe(false);
  });
  it('is false when the key is false, a string, or missing', () => {
    for (const entry of [{ hasTrustDialogAccepted: false }, { hasTrustDialogAccepted: 'true' }, {}, null]) {
      claudeJson({ [repo]: entry });
      expect(isTrusted(repo)).toBe(false);
    }
  });
  it('is false when the file is missing or malformed', () => {
    expect(isTrusted(repo)).toBe(false);
    writeFileSync(join(home, '.claude.json'), '{ not json');
    expect(isTrusted(repo)).toBe(false);
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: ['x'] }));
    expect(isTrusted(repo)).toBe(false);
  });
  it('matches through a symlink on either side', () => {
    const link = join(root, 'link-to-widgets');
    symlinkSync(repo, link);
    claudeJson({ [repo]: yes });
    expect(isTrusted(link)).toBe(true);
    claudeJson({ [link]: yes });
    expect(isTrusted(repo)).toBe(true);
  });
  it('a symlink that points at an untrusted target is not trusted, whatever the link is called', () => {
    const other = join(root, 'work', 'other');
    mkdirSync(join(other, '.git'), { recursive: true });
    const link = join(root, 'work', 'widgets-alias');
    symlinkSync(other, link);
    claudeJson({ [repo]: yes });
    expect(isTrusted(link)).toBe(false);
  });
});

describe('trustedDir with CLAUDE_CONFIG_DIR', () => {
  it('reads $CLAUDE_CONFIG_DIR/.claude.json and never the home file when it is set', () => {
    const cfg = join(root, 'cfg');
    claudeJson({ [repo]: yes }, home);
    expect(isTrusted(repo, { CLAUDE_CONFIG_DIR: cfg })).toBe(false);
    claudeJson({ [repo]: yes }, cfg);
    expect(isTrusted(repo, { CLAUDE_CONFIG_DIR: cfg })).toBe(true);
  });
  it('an empty value counts as unset, as Claude Code does', () => {
    claudeJson({ [repo]: yes }, home);
    expect(isTrusted(repo, { CLAUDE_CONFIG_DIR: '' })).toBe(true);
  });
});

describe('folderTrust across agents', () => {
  it('names Claude Code when its record trusts the folder', () => {
    claudeJson({ [repo]: yes });
    expect(verdict(repo)).toEqual({ dir: repo, by: 'Claude Code' });
  });
  it('trusts a folder Codex marked trusted, and not one it marked untrusted', () => {
    write(join(home, '.codex', 'config.toml'), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
    expect(verdict(join(repo, 'packages', 'api'))).toEqual({ dir: repo, by: 'Codex' });
    write(join(home, '.codex', 'config.toml'), `[projects.${JSON.stringify(repo)}]\ntrust_level = "untrusted"\n`);
    expect(verdict(repo)).toBeUndefined();
  });
  it('reads $CODEX_HOME/config.toml when it is set', () => {
    const codexHome = join(root, 'codex-home');
    write(join(codexHome, 'config.toml'), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`);
    expect(verdict(repo)).toBeUndefined();
    expect(verdict(repo, { CODEX_HOME: codexHome })?.by).toBe('Codex');
  });
  it('treats an unparseable Codex config as no record', () => {
    write(join(home, '.codex', 'config.toml'), '[projects."');
    expect(verdict(repo)).toBeUndefined();
  });
  it('trusts a folder listed in Copilot CLI trusted_folders, comments allowed', () => {
    write(join(home, '.copilot', 'config.json'), `// managed\n{ "trusted_folders": [${JSON.stringify(repo)}] }\n`);
    expect(verdict(repo)).toEqual({ dir: repo, by: 'Copilot CLI' });
    write(join(home, '.copilot', 'config.json'), `{ "trusted_folders": ${JSON.stringify(repo)} }`);
    expect(verdict(repo)).toBeUndefined();
  });
  it('trusts a folder a Gemini CLI rule covers, including from a parent rule', () => {
    write(join(home, '.gemini', 'trustedFolders.json'), JSON.stringify({ [join(root, 'work')]: 'TRUST_FOLDER' }));
    expect(verdict(repo)).toEqual({ dir: repo, by: 'Gemini CLI' });
    write(join(home, '.gemini', 'trustedFolders.json'), JSON.stringify({ [repo]: 'DO_NOT_TRUST' }));
    expect(verdict(repo)).toBeUndefined();
  });
  it('ignores GEMINI_CLI_TRUST_WORKSPACE, which trusts every folder, not this one', () => {
    expect(verdict(repo, { GEMINI_CLI_TRUST_WORKSPACE: 'true' })).toBeUndefined();
  });
  it('trusts a folder a Qwen Code rule covers only when Qwen folder trust is on', () => {
    write(join(home, '.qwen', 'trustedFolders.json'), JSON.stringify({ [repo]: 'TRUST_FOLDER' }));
    expect(verdict(repo)).toBeUndefined();
    write(join(home, '.qwen', 'settings.json'), JSON.stringify({ security: { folderTrust: { enabled: true } } }));
    expect(verdict(repo)).toEqual({ dir: repo, by: 'Qwen Code' });
  });
  it('trusts a folder recorded by Align itself, and rememberAlignTrust records it once, privately', () => {
    expect(verdict(repo)).toBeUndefined();
    rememberAlignTrust(repo, alignDir());
    rememberAlignTrust(repo, alignDir());
    expect(verdict(repo)).toEqual({ dir: repo, by: 'Align' });
    const file = join(alignDir(), 'trusted-folders.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ folders: [repo] });
    // Windows has no POSIX mode bits: Node reports 0o666 whatever chmod asked for.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
  });
  it('keeps folders already recorded by Align when adding one', () => {
    const other = join(root, 'work', 'other');
    rememberAlignTrust(other, alignDir());
    rememberAlignTrust(repo, alignDir());
    expect(JSON.parse(readFileSync(join(alignDir(), 'trusted-folders.json'), 'utf8'))).toEqual({ folders: [other, repo] });
  });
  it('refuses to overwrite a trust file it cannot read, and leaves it byte for byte', () => {
    const file = join(alignDir(), 'trusted-folders.json');
    for (const text of ['{ "folders": [ "/a", ', '{"folders": "/a"}']) {
      write(file, text);
      expect(() => rememberAlignTrust(repo, alignDir())).toThrow('is not valid');
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  });
  it('no agent record trusts the home directory, whoever wrote it', () => {
    mkdirSync(join(home, '.git'), { recursive: true });
    write(join(home, '.codex', 'config.toml'), `[projects.${JSON.stringify(home)}]\ntrust_level = "trusted"\n`);
    rememberAlignTrust(home, alignDir());
    expect(verdict(home)).toBeUndefined();
  });
});

describe('repoHasHarness', () => {
  it('is true when the repo root holds .claude, .agents or .pi, and false when it holds none', () => {
    const sub = join(repo, 'packages', 'api');
    expect(repoHasHarness(sub)).toBe(false);
    for (const d of ['.claude', '.agents', '.pi']) {
      mkdirSync(join(repo, d));
      expect(repoHasHarness(sub)).toBe(true);
      rmSync(join(repo, d), { recursive: true });
    }
  });
  it('counts .codex and .gemini only when they hold skills, since both also hold plain config', () => {
    for (const d of ['.codex', '.gemini']) {
      mkdirSync(join(repo, d));
      expect(repoHasHarness(repo)).toBe(false);
      mkdirSync(join(repo, d, 'skills'));
      expect(repoHasHarness(repo)).toBe(true);
      rmSync(join(repo, d), { recursive: true });
    }
  });
});
