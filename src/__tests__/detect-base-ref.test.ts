/**
 * `align review` (David Boulderstone's feedback, 2026-09-20).
 *
 * He asked for: "when you open a pr/mr I want to be able to ask align if the new code is
 * aligned with the decisions we've made so far, almost like a pre-commit."
 *
 * That capability already shipped - `align check --base origin/main` is exactly it. He is an
 * experienced engineer who had the CLI in front of him and still asked for it, so the defect
 * is the front door, not the engine: `check` reads as "my working tree right now", and the PR
 * case needed a flag he had no reason to guess.
 *
 * There is also a real bug behind that flag. On a CLEAN branch with commits - which is the
 * normal state when you open a PR - `align check` finds nothing staged, falls back to
 * `git diff HEAD` (empty), prints "No changes to check" and exits 0. A gate that examined
 * nothing, reporting success. `--base` exists to remove exactly that false green and only
 * helps the people who already know to pass it.
 *
 * So: detect the base ref, and let the PR case work without a flag.
 */
import { describe, expect, it } from 'vitest';

import { pickBaseRef } from '../lib/git.js';

describe('pickBaseRef (ALI-1105, David feedback)', () => {
  it('prefers the remote HEAD the repo actually declares', () => {
    expect(
      pickBaseRef(['remote:origin/HEAD -> origin/trunk', 'remote:origin/trunk', 'remote:origin/main'])
    ).toBe('origin/trunk');
  });

  /**
   * The second example per rule. With only one candidate any implementation returning
   * "the first thing" passes; this pins that the ORDER is a preference and not an accident,
   * and that `main` beats `master` when a repo carries both (a renamed default often leaves
   * the old branch behind, and it is stale by definition).
   */
  it('falls back through main then master when no remote HEAD is declared', () => {
    expect(
      pickBaseRef(['remote:origin/master', 'remote:origin/main', 'remote:origin/feature'])
    ).toBe('origin/main');
    expect(pickBaseRef(['remote:origin/master', 'remote:origin/feature'])).toBe('origin/master');
  });

  it('prefers a REMOTE ref over a local one of the same name', () => {
    // A local `main` can be arbitrarily stale; the remote is what the PR will merge into.
    expect(pickBaseRef(['main', 'remote:origin/main'])).toBe('origin/main');
  });

  it('uses a local branch when the repo has no remote at all', () => {
    // True local-only use is a first-class mode here, not an edge case: the person who asked
    // for this runs Align entirely locally, and deployment-mode parity is a hard rule.
    expect(pickBaseRef(['main'])).toBe('main');
    expect(pickBaseRef(['master'])).toBe('master');
  });

  /**
   * The negative control. Returning a plausible-but-absent default like 'origin/main' would
   * make every later `git diff` fail with a confusing message on a repo that has no such ref,
   * and an unresolvable base must be loud rather than guessed - the same reasoning that makes
   * check.ts exit EXIT_UNKNOWN on a bad `--base`.
   */
  it('returns null when nothing looks like a base branch', () => {
    expect(pickBaseRef(['remote:origin/feature-a', 'wip'])).toBeNull();
    expect(pickBaseRef([])).toBeNull();
  });

  it('ignores the arrow form when it points at a branch that is not listed', () => {
    // `origin/HEAD -> origin/main` with no `origin/main` entry means the symbolic ref is
    // dangling, which happens after a default-branch rename. Fall through rather than
    // returning a ref that will not resolve.
    expect(
      pickBaseRef(['remote:origin/HEAD -> origin/gone', 'remote:origin/master'])
    ).toBe('origin/master');
  });

  /**
   * Copilot, #309: the local fallback was reached whenever no `origin/main` or `origin/master`
   * existed - so a repo whose default is `origin/develop`, with a stale local `main` left over,
   * returned `main`. The three-dot diff then reviews the branch against an unrelated base, and
   * the output looks entirely plausible. A local branch is only the right answer when there is
   * no remote to ask.
   */
  it('does NOT fall back to a local branch when remote refs exist', () => {
    expect(pickBaseRef(['remote:origin/develop', 'main'])).toBeNull();
    expect(
      pickBaseRef(['remote:origin/develop', 'remote:origin/feature', 'master']),
    ).toBeNull();
  });

  it('still honours the remote default when the repo declares one', () => {
    expect(
      pickBaseRef(['remote:origin/HEAD -> origin/develop', 'remote:origin/develop', 'main'])
    ).toBe('origin/develop');
  });

  /** The positive control for the rule above: with no remote at all, local IS the answer. */
  it('uses a local branch only when nothing remote is present', () => {
    expect(pickBaseRef(['main', 'feature/x'])).toBe('main');
  });

  /**
   * The `origin/` prefix is a convention, not a guarantee. A fork checkout whose only remote is
   * `upstream` has remote refs and no `origin/` anything, and keying the rule on that literal
   * prefix sent it back to the stale-local-branch bug for exactly those repos. `listBranchNames`
   * marks remotes explicitly for this reason, so the caller never has to guess from the name.
   */
  it('treats ANY remote as a remote, not just origin', () => {
    expect(pickBaseRef(['remote:upstream/main', 'main'])).toBe('upstream/main');
    expect(pickBaseRef(['remote:upstream/develop', 'main'])).toBeNull();
  });

  /** A local branch with a slash in its name is not a remote, and must not read as one. */
  it('does not mistake a slashed LOCAL branch for a remote', () => {
    expect(pickBaseRef(['feature/login', 'main'])).toBe('main');
  });

  /**
   * Copilot, #310: the HEAD target was validated against the MERGED name set, which has had
   * the remote marker stripped. So a dangling `origin/HEAD -> origin/trunk` alongside a LOCAL
   * branch coincidentally named `origin/trunk` resolved to the local branch, and the whole
   * point of the marker - never confuse the two - was lost on the one path that most needs it.
   */
  it('does not accept a LOCAL branch as the remote HEAD target', () => {
    expect(
      pickBaseRef(['remote:origin/HEAD -> origin/trunk', 'origin/trunk', 'remote:origin/master']),
    ).toBe('origin/master');
  });

  it('still resolves HEAD when the target really is a remote', () => {
    expect(
      pickBaseRef(['remote:origin/HEAD -> origin/trunk', 'remote:origin/trunk']),
    ).toBe('origin/trunk');
  });
});
