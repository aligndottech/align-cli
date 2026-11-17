/**
 * The repo dimension for the local graph.
 *
 * Test List:
 * 1. a hosted commit URL -> host/owner/repo
 * 2. a hosted pull URL -> the same (two examples per rule)
 * 3. a GitLab subgroup commit URL keeps the subgroup path intact
 * 4. NEGATIVE: a remoteless git://commit URL, a Jira browse URL, and a bare host all -> null
 * 5. PARITY: repoFromSourceUrl(buildCommitUrl(remote, sha)) === repoFromRemoteUrl(remote),
 *    for ssh + https, github + gitlab, and an unrecognised host - the two-writers guard.
 * 6. currentRepoIdentity: outside a git repo -> null; with an unrecognised/absent remote,
 *    falls back to the repo root path.
 * 7. a linked worktree whose identity is a path has the MAIN checkout's identity (async and
 *    sync readers), from its root and from a folder inside it; a main checkout is unchanged.
 */
import { execa } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCommitUrl } from '../lib/git.js';
import { currentRepoIdentity, currentRepoIdentitySync, mainRootOfLinkedWorktree, repoFromRemoteUrl, repoFromSourceUrl, resolveScopeOpts } from '../lib/repo-identity.js';

describe('repoFromSourceUrl', () => {
  it('parses a hosted GitHub commit URL', () => {
    expect(repoFromSourceUrl('https://github.com/aligndottech/align-cli/commit/07232d9')).toBe('github.com/aligndottech/align-cli');
  });

  it('parses a hosted GitHub pull URL (a second example, not just commit)', () => {
    expect(repoFromSourceUrl('https://github.com/aligndottech/align-cli/pull/76')).toBe('github.com/aligndottech/align-cli');
  });

  it('lowercases the identity so differently-cased links to the same repo group together', () => {
    expect(repoFromSourceUrl('https://GitHub.com/AlignDotTech/Align-CLI/pull/76')).toBe('github.com/aligndottech/align-cli');
  });

  it('keeps a GitLab subgroup path intact rather than cutting at the first slash', () => {
    expect(repoFromSourceUrl('https://gitlab.com/group/sub/repo/-/commit/abc1234')).toBe('gitlab.com/group/sub/repo');
  });

  /**
   * Copilot review on #225: `GitLabFetcher.fetch` (connector-core) stamps every imported
   * merge request's `source_url` with GitLab's own `web_url`, which is
   * `.../-/merge_requests/<iid>` - a verb this regex did not list. Every GitLab import
   * would have landed unattributed, silently defeating repo scoping for GitLab users
   * specifically (verified against connector-core's actual fetcher, not just the claim).
   */
  it('parses a hosted GitLab merge request URL - the shape GitLabFetcher actually emits', () => {
    expect(repoFromSourceUrl('https://gitlab.com/acme/widgets/-/merge_requests/42')).toBe('gitlab.com/acme/widgets');
  });

  it('parses a GitLab subgroup merge request URL too (a second example, not just the top level)', () => {
    expect(repoFromSourceUrl('https://gitlab.com/group/sub/repo/-/merge_requests/7')).toBe('gitlab.com/group/sub/repo');
  });

  it.each([
    ['git://commit/abc1234', 'a remoteless git commit'],
    ['https://aligndottech.atlassian.net/browse/APP-1', 'a Jira ticket URL'],
    ['https://linear.app/aligndottech/issue/APP-1', 'a Linear ticket URL'],
    ['https://github.com/aligndottech/pull/1', 'an owner page, no repo segment'],
    [null, 'a null source_url'],
  ])('does not identify a repo for %j (%s)', (url) => {
    expect(repoFromSourceUrl(url)).toBeNull();
  });
});

describe('repoFromSourceUrl(buildCommitUrl(...)) === repoFromRemoteUrl(...) - one fact, two writers', () => {
  it.each([
    ['git@github.com:aligndottech/align-cli.git', 'github.com/aligndottech/align-cli'],
    ['https://github.com/aligndottech/align-cli.git', 'github.com/aligndottech/align-cli'],
    ['git@gitlab.com:group/repo.git', 'gitlab.com/group/repo'],
    ['https://gitlab.com/group/repo.git', 'gitlab.com/group/repo'],
    ['git@bitbucket.org:acme/repo.git', null],
  ])('%s -> %j, agreeing with buildCommitUrl', (remote, expected) => {
    expect(repoFromRemoteUrl(remote)).toBe(expected);
    // Positive control on the parity claim itself: exercise the SAME url buildCommitUrl
    // would hand to a real import, and confirm the two readers agree on it.
    expect(repoFromSourceUrl(buildCommitUrl(remote, 'abc1234567'))).toBe(expected);
  });

  it('a remoteless repo agrees on both sides: no identity either way', () => {
    expect(repoFromRemoteUrl(null)).toBeNull();
    expect(repoFromSourceUrl(buildCommitUrl(null, 'abc1234567'))).toBeNull();
  });
});

describe('currentRepoIdentity', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali798-repo-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null outside a git repo - nothing to stamp, nothing to scope to', async () => {
    expect(await currentRepoIdentity({ cwd: dir })).toBeNull();
  });

  it('falls back to the repo root path when there is no recognised remote', async () => {
    await execa('git', ['init'], { cwd: dir });
    const identity = await currentRepoIdentity({ cwd: dir });
    // macOS resolves os.tmpdir() through a /private symlink, so compare against what
    // git itself reports rather than the dir we minted - `dir` alone is not stable here.
    const { stdout: root } = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
    expect(identity).toBe(root.trim());
  });

  it('prefers the remote identity over the path fallback when one is recognised', async () => {
    await execa('git', ['init'], { cwd: dir });
    await execa('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir });
    expect(await currentRepoIdentity({ cwd: dir })).toBe('github.com/acme/widgets');
  });

  // The path fallback named the folder git was run in, so every linked worktree of one repo was
  // a repo of its own: a scoped search there matched none of the decisions stamped from the main
  // checkout. A self-hosted remote is the common way to reach the fallback.
  describe('in a linked worktree, when the path is the identity', () => {
    const commit = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'];
    let main: string;
    let linked: string;

    beforeEach(async () => {
      main = path.join(dir, 'main');
      linked = path.join(dir, 'linked');
      fs.mkdirSync(main);
      await execa('git', ['init', '-q'], { cwd: main });
      await execa('git', commit, { cwd: main });
      await execa('git', ['worktree', 'add', '-q', '--detach', linked], { cwd: main });
    });

    it('is the main checkout, for a remoteless repo', async () => {
      const identity = await currentRepoIdentity({ cwd: main });
      expect(identity).not.toBeNull();
      expect(await currentRepoIdentity({ cwd: linked })).toBe(identity);
      expect(currentRepoIdentitySync({ cwd: linked })).toBe(identity);
    });

    it('is the main checkout, for a remote on a host that is not recognised', async () => {
      await execa('git', ['remote', 'add', 'origin', 'ssh://git@git.example.com:2224/acme/widgets.git'], { cwd: main });
      const identity = await currentRepoIdentity({ cwd: main });
      expect(await currentRepoIdentity({ cwd: linked })).toBe(identity);
      expect(currentRepoIdentitySync({ cwd: linked })).toBe(identity);
    });

    it('is the main checkout from a folder inside the linked worktree too', async () => {
      const inner = path.join(linked, 'src');
      fs.mkdirSync(inner);
      expect(await currentRepoIdentity({ cwd: inner })).toBe(await currentRepoIdentity({ cwd: main }));
      expect(currentRepoIdentitySync({ cwd: inner })).toBe(currentRepoIdentitySync({ cwd: main }));
    });

    it('leaves the main checkout itself, and a folder inside it, on the repo root', async () => {
      const inner = path.join(main, 'src');
      fs.mkdirSync(inner);
      const { stdout: root } = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: main });
      expect(await currentRepoIdentity({ cwd: inner })).toBe(root.trim());
      expect(currentRepoIdentitySync({ cwd: inner })).toBe(root.trim());
    });

    it('still prefers a recognised remote', async () => {
      await execa('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: main });
      expect(await currentRepoIdentity({ cwd: linked })).toBe('github.com/acme/widgets');
    });
  });
});

describe('mainRootOfLinkedWorktree', () => {
  it('is null in a main checkout, where the two git folders are one', () => {
    expect(mainRootOfLinkedWorktree('/r/main/.git\n/r/main/.git')).toBeNull();
  });

  it('is the folder that holds the shared .git, in a linked worktree', () => {
    expect(mainRootOfLinkedWorktree('/r/main/.git/worktrees/linked\n/r/main/.git')).toBe('/r/main');
    expect(mainRootOfLinkedWorktree('C:/r/main/.git/worktrees/linked\r\nC:/r/main/.git')).toBe('C:/r/main');
  });

  it('is null when the shared folder is not a checkout\'s .git (a bare repo, a submodule): there is no main checkout to name', () => {
    expect(mainRootOfLinkedWorktree('/r/bare.git/worktrees/linked\n/r/bare.git')).toBeNull();
    expect(mainRootOfLinkedWorktree('/r/super/.git/modules/sub/worktrees/linked\n/r/super/.git/modules/sub')).toBeNull();
  });

  it('is null when git gave no answer (not a repo, or a git too old for --path-format)', () => {
    expect(mainRootOfLinkedWorktree(null)).toBeNull();
    expect(mainRootOfLinkedWorktree('')).toBeNull();
    expect(mainRootOfLinkedWorktree('/r/main/.git')).toBeNull();
  });
});

describe('resolveScopeOpts', () => {
  it('returns undefined - "no opinion" - when neither flag was typed', () => {
    const warnings: string[] = [];
    expect(resolveScopeOpts({}, 'local', (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('passes {repo, all} through unchanged in local mode', () => {
    const warnings: string[] = [];
    expect(resolveScopeOpts({ repo: 'align-cli' }, 'local', (m) => warnings.push(m))).toEqual({ repo: 'align-cli', all: undefined });
    expect(warnings).toEqual([]);
  });

  it('warns and drops the flags outside local mode - never a silent no-op', () => {
    const warnings: string[] = [];
    expect(resolveScopeOpts({ all: true }, 'prod', (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});
