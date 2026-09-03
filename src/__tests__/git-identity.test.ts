/**
 * ALI-831: `getGitIdentity` against a real git repo, since `ratified_by` is what it writes.
 * Email before name, null when neither is set - the caller then falls back to the OS user.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGitIdentity } from '../lib/git.js';

let dir: string;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali831-git-'));
  await execa('git', ['init', '-q'], { cwd: dir });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Repo-local config only, and GIT_CONFIG_GLOBAL pointed at nothing, so the machine's own
// identity cannot leak into the fixture and make the null case pass by accident.
const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
async function identity(): Promise<string | null> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await getGitIdentity({ cwd: dir });
  } finally {
    delete process.env['GIT_CONFIG_GLOBAL'];
    delete process.env['GIT_CONFIG_SYSTEM'];
    Object.assign(process.env, saved);
  }
}

describe('getGitIdentity', () => {
  it('prefers user.email', async () => {
    await execa('git', ['config', 'user.name', 'Tom Knee'], { cwd: dir });
    await execa('git', ['config', 'user.email', 'tom@align.tech'], { cwd: dir });
    expect(await identity()).toBe('tom@align.tech');
  });

  it('falls back to user.name', async () => {
    await execa('git', ['config', 'user.name', 'Tom Knee'], { cwd: dir });
    expect(await identity()).toBe('Tom Knee');
  });

  it('is null when git knows neither, rather than an empty string', async () => {
    expect(await identity()).toBeNull();
  });
});
