/**
 * `align setup --local` must complete when no TTY is attached.
 *
 * Found by the install-smoke matrix (first full run): the connector multiselect
 * at the end of runLocalSetup has no non-TTY guard, so a scripted run (CI,
 * docker, a piped terminal) does ALL the setup work - local graph, agent
 * alignment files, git import - and then crashes with
 * `uv_tty_init returned EINVAL`, exit 1. The user's last impression is a crash
 * reporting failure for work that succeeded. Same defect family as ALI-422/
 * ALI-160 (ERR_TTY_INIT_FAILED on non-TTY imports), one prompt further down.
 *
 * The fixture is a NON-git directory on purpose: isGitRepo() false skips the
 * embedded-model import, so the test reaches the prompt in seconds and needs
 * no network. stdin is 'ignore' - the precondition (no TTY) is established
 * explicitly, not inherited from the runner (tdd.md: a test must establish its
 * own preconditions, especially environmental ones).
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = join(ROOT, 'src', 'index.ts');

describe('align setup --local without a TTY', () => {
  it('exits 0 and reaches the outro instead of crashing at the connector prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'align-nontty-'));
    const home = mkdtempSync(join(tmpdir(), 'align-nontty-home-'));

    // execFile pipes stdio by default: stdin is a non-TTY pipe, which is the
    // exact condition under test. HOME is isolated so the run cannot touch the
    // developer's real align config.
    const { stdout, stderr } = await exec(
      process.execPath,
      [TSX, ENTRY, 'setup', '--local'],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          APPDATA: join(home, 'AppData', 'Roaming'),
          LOCALAPPDATA: join(home, 'AppData', 'Local'),
        },
        timeout: 120_000,
      },
    );
    // execFile rejects on non-zero exit, so reaching here IS the exit-0 assertion.
    const out = stdout + stderr;
    expect(out).toContain('Local graph ready');
    // The crash happened after success output, so asserting exit 0 alone is not
    // enough - the outro is the proof the flow COMPLETED rather than died late.
    expect(out).toContain('You are set up in local mode');
    expect(out).not.toContain('TTY initialization failed');
  }, 150_000);
});
