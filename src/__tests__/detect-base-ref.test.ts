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

describe('pickBaseRef (ALI-1097 / David feedback)', () => {
  it('prefers the remote HEAD the repo actually declares', () => {
    expect(pickBaseRef(['origin/HEAD -> origin/trunk', 'origin/trunk', 'origin/main'])).toBe(
      'origin/trunk'
    );
  });

  /**
   * The second example per rule. With only one candidate any implementation returning
   * "the first thing" passes; this pins that the ORDER is a preference and not an accident,
   * and that `main` beats `master` when a repo carries both (a renamed default often leaves
   * the old branch behind, and it is stale by definition).
   */
  it('falls back through main then master when no remote HEAD is declared', () => {
    expect(pickBaseRef(['origin/master', 'origin/main', 'origin/feature'])).toBe('origin/main');
    expect(pickBaseRef(['origin/master', 'origin/feature'])).toBe('origin/master');
  });

  it('prefers a REMOTE ref over a local one of the same name', () => {
    // A local `main` can be arbitrarily stale; the remote is what the PR will merge into.
    expect(pickBaseRef(['main', 'origin/main'])).toBe('origin/main');
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
    expect(pickBaseRef(['origin/feature-a', 'wip'])).toBeNull();
    expect(pickBaseRef([])).toBeNull();
  });

  it('ignores the arrow form when it points at a branch that is not listed', () => {
    // `origin/HEAD -> origin/main` with no `origin/main` entry means the symbolic ref is
    // dangling, which happens after a default-branch rename. Fall through rather than
    // returning a ref that will not resolve.
    expect(pickBaseRef(['origin/HEAD -> origin/gone', 'origin/master'])).toBe('origin/master');
  });
});
