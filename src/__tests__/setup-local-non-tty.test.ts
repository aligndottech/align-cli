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
 * no network. The no-TTY precondition is established explicitly by spawning
 * with piped stdio (execFile's default) rather than inherited from the runner
 * (tdd.md: a test must establish its own preconditions, especially
 * environmental ones). The pipe exercises the HANG failure mode; the closed
 * stdin (crash) variant is covered by the install-smoke script, whose timeout
 * runner spawns with stdin 'ignore'.
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

describe('align --local without a TTY', () => {
  it('exits 0 and reaches the outro instead of crashing at the connector prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'align-nontty-'));
    const home = mkdtempSync(join(tmpdir(), 'align-nontty-home-'));

    // execFile pipes stdio by default: stdin is a non-TTY pipe, which is the
    // exact condition under test. HOME is isolated so the run cannot touch the
    // developer's real align config.
    const { stdout, stderr } = await exec(
      process.execPath,
      [TSX, ENTRY, '--local'],
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

  it('prints a specific next step when the graph comes out empty', async () => {
    // A non-git, doc-less directory: nothing to import, so the graph is empty by construction.
    const cwd = mkdtempSync(join(tmpdir(), 'align-empty-'));
    const home = mkdtempSync(join(tmpdir(), 'align-empty-home-'));
    const { stdout, stderr } = await exec(process.execPath, [TSX, ENTRY, '--local'], {
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
    });
    const out = stdout + stderr;
    expect(out).toContain('Your graph is empty');
    expect(out).toContain('align connect github');
    expect(out).toContain('align connect docs');
  }, 150_000);

  // The hint prints commands the user will copy. With a cloud graph as the bare default
  // (ALIGN_ENV exported or logged in) a bare `align connect github` fills THAT graph, not the one
  // this run just built, so every printed command has to say --env local.
  const emptyRun = async (alignEnv: string | undefined): Promise<string> => {
    const cwd = mkdtempSync(join(tmpdir(), 'align-empty-env-'));
    const home = mkdtempSync(join(tmpdir(), 'align-empty-env-home-'));
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
    };
    delete env['ALIGN_ENV'];
    if (alignEnv) env['ALIGN_ENV'] = alignEnv;
    const { stdout, stderr } = await exec(process.execPath, [TSX, ENTRY, '--local'], { cwd, env, timeout: 120_000 });
    return stdout + stderr;
  };

  it('with a cloud graph as the bare default, the hint commands say --env local', async () => {
    const out = await emptyRun('preview');
    expect(out).toContain('Bare commands (align ask, align connect ...) use the preview cloud graph'); // precondition reached
    expect(out).toContain('align connect github --env local');
    expect(out).toContain('align connect docs --env local');
    expect(out).toMatch(/align connect --env local\s+pick another source/);
  }, 150_000);

  it('with the local graph as the bare default, the hint commands carry no --env', async () => {
    const out = await emptyRun(undefined);
    expect(out).toContain('align connect github');
    expect(out).not.toContain('Bare commands (align ask');
    expect(out).not.toContain('align connect github --env');
  }, 150_000);
});
