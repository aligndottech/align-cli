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
 * 8. a URL-form remote that names a port (GitHub's SSH-over-443 host, an explicit :22) is the
 *    same repo as the plain remote, on both sides of the parity; an scp-form remote whose owner
 *    is all digits is not read as a port.
 */
import { execa } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBlobUrl, buildCommitUrl } from '../lib/git.js';
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

  it.each([
    ['ssh://git@ssh.github.com:443/aligndottech/align-cli.git', 'github.com/aligndottech/align-cli'],
    ['ssh://git@github.com:22/aligndottech/align-cli.git', 'github.com/aligndottech/align-cli'],
    ['https://github.com:443/aligndottech/align-cli.git', 'github.com/aligndottech/align-cli'],
    ['ssh://git@altssh.gitlab.com:443/group/sub/repo.git', 'gitlab.com/group/sub/repo'],
    ['git@github.com:1234/repo.git', 'github.com/1234/repo'],
  ])('a port in %s is not part of the repo (-> %j)', (remote, expected) => {
    expect(repoFromRemoteUrl(remote)).toBe(expected);
    expect(repoFromSourceUrl(buildCommitUrl(remote, 'abc1234567'))).toBe(expected);
    expect(repoFromSourceUrl(buildBlobUrl(remote, 'main', 'docs/adr/0001-x.md'))).toBe(expected);
  });

  it('a remoteless repo agrees on both sides: no identity either way', () => {
    expect(repoFromRemoteUrl(null)).toBeNull();
    expect(repoFromSourceUrl(buildCommitUrl(null, 'abc1234567'))).toBeNull();
  });
});

// A docs row's URL is a file in the repo, not a commit. Reading only commit-shaped URLs left every docs row
// with no repo, and a row with no repo is shown in every repo.
describe('repoFromSourceUrl on a docs row (a /blob/ URL)', () => {
  it.each([
    ['https://github.com/acme/api/blob/main/docs/adr/0001-x.md', 'github.com/acme/api'],
    ['https://github.com/acme/api/blob/feature/storage/CLAUDE.md#testing', 'github.com/acme/api'],
    ['https://gitlab.com/group/sub/repo/-/blob/main/docs/a.md', 'gitlab.com/group/sub/repo'],
    ['https://github.com/Acme/API/blob/main/README.md', 'github.com/acme/api'],
    // A branch or folder named like one of the commit-URL verbs must not be read as one.
    ['https://github.com/acme/api/blob/issues/123/README.md', 'github.com/acme/api'],
    ['https://github.com/acme/api/blob/pull/5/docs/a.md', 'github.com/acme/api'],
    ['https://github.com/acme/api/blob/main/docs/commit/abc123/notes.md', 'github.com/acme/api'],
    // GitLab's own marker is the boundary, even when `blob` is also a subgroup name.
    ['https://gitlab.com/acme/platform/blob/docs/-/blob/main/README.md', 'gitlab.com/acme/platform/blob/docs'],
    // Controls: the commit, pull and issue shapes still read as before, including a repo that is named `blob`.
    ['https://github.com/acme/blob/pull/5', 'github.com/acme/blob'],
    ['https://github.com/acme/api/commit/abc1234', 'github.com/acme/api'],
  ])('%s -> %s', (url, expected) => {
    expect(repoFromSourceUrl(url)).toBe(expected);
  });

  it('a remoteless repo has no identity from its git://blob/ URL', () => {
    expect(repoFromSourceUrl('git://blob/main/docs/adr/0001-x.md')).toBeNull();
  });

  it.each([
    ['git@github.com:aligndottech/align-cli.git', 'github.com/aligndottech/align-cli'],
    ['https://gitlab.com/group/repo.git', 'gitlab.com/group/repo'],
    ['git@bitbucket.org:acme/repo.git', null],
  ])('agrees with the remote reader for %s', (remote, expected) => {
    expect(repoFromRemoteUrl(remote)).toBe(expected);
    expect(repoFromSourceUrl(buildBlobUrl(remote, 'main', 'docs/adr/0001-x.md'))).toBe(expected);
    // Whatever the branch is called, the same remote gives the same repo.
    expect(repoFromSourceUrl(buildBlobUrl(remote, 'issues/123', 'docs/adr/0001-x.md'))).toBe(expected);
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

    // The fixture commits, and a GIT_DIR or GIT_WORK_TREE inherited from a hook would point that
    // commit at the invoking repo whatever the cwd, so git's own variables stay out of it.
    const fixtureGit = (args: string[], cwd: string) =>
      execa('git', args, { cwd, extendEnv: false, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) });

    beforeEach(async () => {
      main = path.join(dir, 'main');
      linked = path.join(dir, 'linked');
      fs.mkdirSync(main);
      await fixtureGit(['init', '-q'], main);
      await fixtureGit(commit, main);
      await fixtureGit(['worktree', 'add', '-q', '--detach', linked], main);
    });

    it('is the main checkout, for a remoteless repo', async () => {
      const identity = await currentRepoIdentity({ cwd: main });
      expect(identity).not.toBeNull();
      expect(await currentRepoIdentity({ cwd: linked })).toBe(identity);
      expect(currentRepoIdentitySync({ cwd: linked })).toBe(identity);
    });

    it('is the main checkout, for a remote on a host that is not recognised', async () => {
      await fixtureGit(['remote', 'add', 'origin', 'ssh://git@git.example.com:2224/acme/widgets.git'], main);
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
      const { stdout: root } = await fixtureGit(['rev-parse', '--show-toplevel'], main);
      expect(await currentRepoIdentity({ cwd: inner })).toBe(root.trim());
      expect(currentRepoIdentitySync({ cwd: inner })).toBe(root.trim());
    });

    // A bare repo kept in a folder named .git, with its worktrees beside it: the shared folder looks like
    // a checkout's .git, but the folder that holds it is not a checkout.
    it('keeps its own root when the shared repo is bare, even one named .git', async () => {
      const home = path.join(dir, 'home');
      const bare = path.join(home, '.git');
      const tree = path.join(home, 'tree');
      fs.mkdirSync(home);
      await fixtureGit(['clone', '-q', '--bare', main, bare], dir);
      await fixtureGit(['worktree', 'add', '-q', '--detach', tree], bare);
      const { stdout: root } = await fixtureGit(['rev-parse', '--show-toplevel'], tree);
      expect(await currentRepoIdentity({ cwd: tree })).toBe(root.trim());
      expect(currentRepoIdentitySync({ cwd: tree })).toBe(root.trim());
    });

    it('still prefers a recognised remote', async () => {
      await fixtureGit(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], main);
      expect(await currentRepoIdentity({ cwd: linked })).toBe('github.com/acme/widgets');
    });
  });
});

describe('mainRootOfLinkedWorktree', () => {
  it('is null in a main checkout, where the two git folders are one', () => {
    expect(mainRootOfLinkedWorktree('/r/main/.git\n/r/main/.git', 'false')).toBeNull();
  });

  it('is the folder that holds the shared .git, in a linked worktree', () => {
    expect(mainRootOfLinkedWorktree('/r/main/.git/worktrees/linked\n/r/main/.git', 'false')).toBe('/r/main');
    expect(mainRootOfLinkedWorktree('C:/r/main/.git/worktrees/linked\r\nC:/r/main/.git', 'false')).toBe('C:/r/main');
    // core.bare unset reads as not bare, which is git's own default.
    expect(mainRootOfLinkedWorktree('/r/main/.git/worktrees/linked\n/r/main/.git', null)).toBe('/r/main');
  });

  it('is null for a bare repo, whatever its folder is called: there is no main checkout to name', () => {
    expect(mainRootOfLinkedWorktree('/r/bare.git/worktrees/linked\n/r/bare.git', 'true')).toBeNull();
    expect(mainRootOfLinkedWorktree('/r/.git/worktrees/linked\n/r/.git', 'true')).toBeNull();
  });

  it('is null when the shared folder is not a checkout\'s .git (a submodule)', () => {
    expect(mainRootOfLinkedWorktree('/r/super/.git/modules/sub/worktrees/linked\n/r/super/.git/modules/sub', 'false')).toBeNull();
  });

  it('is null when git gave no answer (not a repo, or a git too old for --path-format)', () => {
    expect(mainRootOfLinkedWorktree(null, null)).toBeNull();
    expect(mainRootOfLinkedWorktree('', 'false')).toBeNull();
    expect(mainRootOfLinkedWorktree('/r/main/.git', 'false')).toBeNull();
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
