import { describe, expect, it, vi } from 'vitest';
import { gitConfigRunsPrograms } from '../lib/agent/git-runs-programs.js';

const run = (code: number) => vi.fn(async () => ({ code, stdout: code === 0 ? 'core.fsmonitor ./hook' : '' }));

describe('gitConfigRunsPrograms', () => {
  it('is false only when git reports no match (exit 1) for both scopes', async () => {
    const r = run(1);
    expect(await gitConfigRunsPrograms('/repo', r)).toBe(false);
    expect(r.mock.calls.map((c) => c[0]![1])).toEqual(['--local', '--worktree']);
  });
  it('is true when the config names a program (exit 0)', async () => {
    expect(await gitConfigRunsPrograms('/repo', run(0))).toBe(true);
  });
  it.each([[128], [127], [2]])('is true when git could not look (exit %i)', async (code) => {
    expect(await gitConfigRunsPrograms('/repo', run(code))).toBe(true);
  });
  it('is true when only one scope matches', async () => {
    const r = vi.fn().mockResolvedValueOnce({ code: 1, stdout: '' }).mockResolvedValueOnce({ code: 0, stdout: 'x' });
    expect(await gitConfigRunsPrograms('/repo', r)).toBe(true);
  });
});

describe('gitConfigRunsPrograms against a real repository', () => {
  it('sees a core.fsmonitor in the repo config and clears a clean one', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'align-gitcfg-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      expect(await gitConfigRunsPrograms(dir)).toBe(false);
      execFileSync('git', ['config', '--local', 'core.fsmonitor', './hook'], { cwd: dir });
      expect(await gitConfigRunsPrograms(dir)).toBe(true);
      execFileSync('git', ['config', '--local', '--unset', 'core.fsmonitor'], { cwd: dir });
      expect(await gitConfigRunsPrograms(dir)).toBe(false);
      // gpg.program runs on --show-signature, and so does a per-format program.
      for (const key of ['gpg.program', 'gpg.ssh.program']) {
        execFileSync('git', ['config', '--local', key, './signer'], { cwd: dir });
        expect(await gitConfigRunsPrograms(dir), key).toBe(true);
        execFileSync('git', ['config', '--local', '--unset', key], { cwd: dir });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
