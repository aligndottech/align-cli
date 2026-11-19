/**
 * Git runs a program for some read commands when the repository's own config names one. A clone
 * does not carry `.git/config`, but a repo that arrived with its `.git` folder (a tarball, a zip,
 * a copied disk) can. The edit hook and `align check` read such a repo, so none of Align's own
 * git calls may start those programs.
 *
 * Test List:
 * 1. control: plain git in the fixture DOES run the file watcher, the text converter and the
 *    external diff program, so an absent marker below comes from the hardening and not from a
 *    fixture that never fires
 * 2. the three diffs `align check` reads (staged, HEAD, base...HEAD) run none of them
 * 3. the two blames (edit hook, `align stale`) run none of them
 * 4. hardenGitEnv keeps git config a caller already passed through the environment
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { blameCommits } from '../lib/blame-attribution.js';
import { getBaseDiff, getHeadDiff, getStagedDiff } from '../lib/git.js';
import { hardenGitEnv } from '../lib/git-safe-env.js';
import { blameRanges } from '../lib/stale-code.js';

const GIT_ENV_KEYS = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;

describe.skipIf(process.platform === 'win32')('git calls do not run programs a repository names', () => {
  let dir: string;
  let repo: string;
  let markers: string;
  let prevCwd: string;
  let savedEnv: Record<string, string | undefined>;

  const ran = (): string[] => fs.readdirSync(markers).sort();
  const clear = (): void => { for (const f of ran()) fs.rmSync(path.join(markers, f)); };
  const git = (args: string[], env: Record<string, string | undefined> = process.env) => execa('git', args, { cwd: repo, env, extendEnv: false, reject: false });

  const script = (name: string, body = ''): string => {
    const file = path.join(dir, `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\ntouch "${path.join(markers, name)}"\n${body}`, { mode: 0o755 });
    return file;
  };

  beforeEach(async () => {
    savedEnv = Object.fromEntries(Object.keys(process.env).filter((k) => GIT_ENV_KEYS.test(k)).map((k) => [k, process.env[k]]));
    for (const k of Object.keys(savedEnv)) delete process.env[k];
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-git-programs-')));
    repo = path.join(dir, 'repo');
    markers = path.join(dir, 'markers');
    fs.mkdirSync(repo);
    fs.mkdirSync(markers);
    prevCwd = process.cwd();
    process.chdir(repo);
    await git(['init', '-q', '-b', 'main', '.']);
    await git(['config', 'user.email', 'a@example.com']);
    await git(['config', 'user.name', 'tester']);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=planted\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'one']);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'two\n');
    await git(['commit', '-q', '-am', 'two']);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'three\n');
    await git(['add', 'a.txt']);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n');
    await git(['config', 'core.fsmonitor', script('watcher')]);
    await git(['config', 'diff.planted.textconv', script('converter', 'cat "$1"\n')]);
    clear();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    for (const k of Object.keys(process.env)) if (GIT_ENV_KEYS.test(k)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('control: plain git in this fixture runs all three', async () => {
    await git(['diff', 'HEAD']);
    await git(['blame', '-L', '1,2', '--', 'a.txt']);
    expect(ran()).toEqual(['converter', 'watcher']);
    clear();
    await git(['config', 'diff.external', script('external')]);
    await git(['diff', 'HEAD']);
    expect(ran()).toContain('external');
  });

  for (const withExternal of [false, true]) {
    it(`the diffs align check reads run none of them${withExternal ? ', with an external diff program set' : ''}`, async () => {
      if (withExternal) await git(['config', 'diff.external', script('external')]);
      clear();
      hardenGitEnv();
      // Each diff is non-empty, so git had a changed .txt file it would have converted.
      expect(await getStagedDiff()).toContain('+three');
      expect(await getHeadDiff()).toContain('+four');
      expect(await getBaseDiff('HEAD~1')).toContain('+two');
      expect(ran()).toEqual([]);
    });
  }

  it('the blames run none of them', async () => {
    hardenGitEnv();
    const run = async (args: string[]) => ({ stdout: (await execa('git', args, { cwd: repo })).stdout });
    expect((await blameCommits(path.join(repo, 'a.txt'), [[1, 2]], run)).map((c) => c.subject)).toEqual(['one', 'two']);
    const head = (await run(['rev-parse', 'HEAD'])).stdout.trim();
    expect(await blameRanges(async (args) => (await run(args)).stdout, 'HEAD', 'a.txt', head)).toEqual([[2, 2]]);
    expect(ran()).toEqual([]);
  });

  it('keeps git config the caller already passed through the environment', () => {
    const env: Record<string, string | undefined> = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'someone' };
    hardenGitEnv(env);
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'someone',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
    });
    hardenGitEnv(env);
    expect(env['GIT_CONFIG_COUNT']).toBe('2');
  });
});
