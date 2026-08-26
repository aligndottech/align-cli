/**
 * The check step's argument assembly, executed rather than read (ALI-708).
 *
 * The coupling under test: `fail-on: conflict-or-unknown` appends `--depth exhaustive`.
 * A gate that fails on unknown has declared that an unadjudicated skip costs it a build,
 * so it is the caller that pays for the verdict - and the DEFAULT (`conflict`) must NOT
 * pay, or every default user's check moves onto the gateway's 15s adjudication path.
 *
 * The assembly slice is extracted from action.yml and run with `printf '%s\n' "$@"`
 * appended, so the assertion is on the argv the CLI would actually receive - a textual
 * grep over the yaml would pass with the condition inverted.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';

const exec = promisify(execFile);
const ACTION = join(dirname(fileURLToPath(import.meta.url)), '../../.github/actions/align-check/action.yml');

if (!existsSync(ACTION)) throw new Error(`FATAL: ${ACTION} is missing`);

interface CompositeAction {
  runs: { steps: Array<{ id?: string; run?: string }> };
}

const action = load(readFileSync(ACTION, 'utf8')) as CompositeAction;
const checkRun = action.runs.steps.find(s => s.id === 'check')?.run;
if (!checkRun) throw new Error('FATAL: the check step has no run block');

// The assembly is everything before the install; executing further would hit npm.
const installIdx = checkRun.indexOf('PREFIX=');
if (installIdx < 0) throw new Error('FATAL: could not find the end of the arg assembly (PREFIX=)');
const assembly = checkRun
  .slice(0, installIdx)
  // GitHub expressions are substituted before bash ever sees the script; stand them in
  // with a recognisable literal so the slice parses and the base ref stays visible.
  .replace(/\$\{\{\s*steps\.base\.outputs\.ref\s*\}\}/g, 'origin/main');

if (/\$\{\{/.test(assembly)) throw new Error(`FATAL: unsubstituted GitHub expression in the assembly slice:\n${assembly}`);

async function argv(env: Record<string, string>): Promise<string[]> {
  const { stdout } = await exec('bash', ['-c', `${assembly}\nprintf '%s\\n' "$@"`], {
    env: { ...process.env, PR_TITLE: '', FAIL_ON: '', ...env },
  });
  return stdout.split('\n').filter(Boolean);
}

describe('align-check action argument assembly', () => {
  it('strict fail-on pays for the verdict', async () => {
    const args = await argv({ FAIL_ON: 'conflict-or-unknown' });
    expect(args).toContain('--depth');
    expect(args[args.indexOf('--depth') + 1]).toBe('exhaustive');
  });

  it('the default fail-on does not', async () => {
    const args = await argv({ FAIL_ON: 'conflict' });
    // Positive control: the assembly ran and produced the base args, so the absence below
    // is not an artefact of an empty run.
    expect(args).toContain('--ci');
    expect(args).not.toContain('--depth');
  });

  it('the PR title still rides along with the depth', async () => {
    const args = await argv({ FAIL_ON: 'conflict-or-unknown', PR_TITLE: 'Raise the pool to 30' });
    expect(args[args.indexOf('--title') + 1]).toBe('Raise the pool to 30');
    expect(args[args.indexOf('--depth') + 1]).toBe('exhaustive');
  });
});
