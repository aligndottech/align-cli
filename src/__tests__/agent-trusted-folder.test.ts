import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoHasHarness, trustedDir } from '../lib/agent/trusted-folder.js';

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
const isTrusted = (cwd: string, env: Record<string, string | undefined> = {}): boolean => trustedDir(cwd, home, env) !== undefined;

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
});
