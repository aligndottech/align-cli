/**
 * ALI-938: getGitIdentities and hasOtherCommitters, against real temp git repos -
 * mirrors git-identity.test.ts's approach (a mocked execa would only prove the mock
 * was wired, not that git's actual `%ae%n%an` output shape is handled).
 *
 * Test List:
 * 1. getGitIdentities: reads both email and name when both are set
 * 2. getGitIdentities: null/null when git knows neither
 * 3. hasOtherCommitters: false with no local identity to compare against
 * 4. hasOtherCommitters: false when every commit is mine
 * 5. hasOtherCommitters: true when someone else has committed
 * 6. hasOtherCommitters: false on a repo with no commits yet (git log fails)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGitIdentities, hasOtherCommitters } from '../lib/git.js';

let dir: string;

// Repo-local config only, same isolation as git-identity.test.ts - otherwise the
// machine's own global git identity can leak into the fixture.
const CLEAN_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

async function withCleanGitEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, CLEAN_ENV);
  try {
    return await fn();
  } finally {
    delete process.env['GIT_CONFIG_GLOBAL'];
    delete process.env['GIT_CONFIG_SYSTEM'];
    Object.assign(process.env, saved);
  }
}

async function commitAs(name: string, email: string, subject: string): Promise<void> {
  await execa('git', ['commit', '--allow-empty', '-m', subject], {
    cwd: dir,
    env: {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    },
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali938-git-'));
  await execa('git', ['init', '-q'], { cwd: dir });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('getGitIdentities', () => {
  it('reads both email and name when both are set', async () => {
    await withCleanGitEnv(async () => {
      await execa('git', ['config', 'user.name', 'Tom Knee'], { cwd: dir });
      await execa('git', ['config', 'user.email', 'tom@align.tech'], { cwd: dir });
      expect(await getGitIdentities({ cwd: dir })).toEqual({ email: 'tom@align.tech', name: 'Tom Knee' });
    });
  });

  it('is null,null when git knows neither', async () => {
    await withCleanGitEnv(async () => {
      expect(await getGitIdentities({ cwd: dir })).toEqual({ email: null, name: null });
    });
  });
});

describe('hasOtherCommitters', () => {
  it('is false with no local identity to compare against', async () => {
    await commitAs('Dan', 'dan@align.tech', 'a commit');
    expect(await hasOtherCommitters({ email: null, name: null }, { cwd: dir })).toBe(false);
  });

  it('is false when every commit is mine', async () => {
    await commitAs('Tom Knee', 'tom@align.tech', 'first');
    await commitAs('Tom Knee', 'tom@align.tech', 'second');
    expect(await hasOtherCommitters({ email: 'tom@align.tech', name: 'Tom Knee' }, { cwd: dir })).toBe(false);
  });

  it('is true when someone else has committed', async () => {
    await commitAs('Tom Knee', 'tom@align.tech', 'first');
    await commitAs('Dan Someone', 'dan@align.tech', 'second');
    expect(await hasOtherCommitters({ email: 'tom@align.tech', name: 'Tom Knee' }, { cwd: dir })).toBe(true);
  });

  it('is false on a repo with no commits yet (git log has nothing to say)', async () => {
    expect(await hasOtherCommitters({ email: 'tom@align.tech', name: 'Tom Knee' }, { cwd: dir })).toBe(false);
  });
});
