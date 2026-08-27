/**
 * The check step's argument assembly, executed rather than read (ALI-708).
 *
 * `depth` is an EXPLICIT action input, deliberately not inferred from `fail-on`: an
 * auto-append under strict fail-on would have turned every pinned older CLI and every
 * un-upgraded self-hosted gateway into a permanent red gate the moment the action
 * updated, with no opt-out - and made the assembly a second reader of fail-on's
 * vocabulary, which decide.sh owns. Unset must therefore send NOTHING, so existing
 * consumers are byte-for-byte untouched.
 *
 * The assembly slice is executed with `printf '%s\n' "$@"` appended, so the assertion is
 * on the argv the CLI would actually receive - a textual grep over the yaml would pass
 * with the append inverted or dropped.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';

const exec = promisify(execFile);
const ACTION = join(dirname(fileURLToPath(import.meta.url)), '../../.github/actions/align-check/action.yml');

// The slice terminator is a NAMED marker in action.yml rather than an incidental token of
// the install block, so an install-side edit cannot silently move the boundary, and the
// marker's comment points back here.
const MARKER = '# end-of-arg-assembly';

interface CompositeAction {
  runs: { steps: Array<{ id?: string; run?: string }> };
}

// Loaded in beforeAll rather than at module scope: a collection-time throw reports as a
// bare module error with no test name, while a beforeAll failure names this suite.
let assembly = '';

beforeAll(() => {
  const action = load(readFileSync(ACTION, 'utf8')) as CompositeAction;
  const checkRun = action.runs.steps.find(s => s.id === 'check')?.run;
  if (!checkRun) throw new Error('the check step has no run block');

  const markerIdx = checkRun.indexOf(MARKER);
  if (markerIdx < 0) {
    throw new Error(`the "${MARKER}" marker is gone from the check step - it delimits the slice this suite executes`);
  }
  assembly = checkRun
    .slice(0, markerIdx)
    // GitHub expressions are substituted before bash ever sees the script; stand them in
    // with a recognisable literal so the slice parses and the base ref stays visible.
    .replace(/\$\{\{\s*steps\.base\.outputs\.ref\s*\}\}/g, 'origin/main');

  if (/\$\{\{/.test(assembly)) {
    throw new Error(`unsubstituted GitHub expression in the assembly slice:\n${assembly}`);
  }
});

async function argv(env: Record<string, string>): Promise<string[]> {
  const { stdout } = await exec('bash', ['-c', `${assembly}\nprintf '%s\\n' "$@"`], {
    env: { ...process.env, PR_TITLE: '', DEPTH: '', ...env },
  });
  return stdout.split('\n').filter(Boolean);
}

describe('align-check action argument assembly', () => {
  it('a set depth input is passed through as data', async () => {
    const args = await argv({ DEPTH: 'exhaustive' });
    expect(args).toContain('--depth');
    expect(args[args.indexOf('--depth') + 1]).toBe('exhaustive');
  });

  it('an unset depth sends nothing - existing consumers are untouched', async () => {
    const args = await argv({});
    // Positive control: the assembly ran and produced the base args, so the absence below
    // is not an artefact of an empty run.
    expect(args).toContain('--ci');
    expect(args).not.toContain('--depth');
  });

  it('the PR title still rides along with the depth', async () => {
    const args = await argv({ DEPTH: 'exhaustive', PR_TITLE: 'Raise the pool to 30' });
    expect(args[args.indexOf('--title') + 1]).toBe('Raise the pool to 30');
    expect(args[args.indexOf('--depth') + 1]).toBe('exhaustive');
  });

  it('the value is data, not shell', async () => {
    // The same guarantee PR_TITLE carries: an env value reaches the CLI as one argv
    // entry whatever it contains.
    const hostile = '"; echo pwned; #';
    const args = await argv({ DEPTH: hostile });
    expect(args[args.indexOf('--depth') + 1]).toBe(hostile);
    expect(args.join('\n')).not.toContain('pwned\n');
  });
});
