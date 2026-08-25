/**
 * The composite action must install the CLI WITHOUT its optional dependency.
 *
 * `@huggingface/transformers` (359MB with onnxruntime) backs `--local` mode only, and the
 * action always talks to a gateway, so in CI it is downloaded and never loaded. Measured on
 * 0.17.1 with a cold cache: 431MB in 25s with it, 45MB in 5s without.
 *
 * This is pinned because dropping the flag costs every consumer 20 seconds and 386MB per
 * run and NOTHING would go red - the check still works, just slowly. A silent performance
 * regression is exactly the kind a test has to catch, because no one reads an install log
 * that succeeded.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';

const ACTION = join(dirname(fileURLToPath(import.meta.url)), '../../.github/actions/align-check/action.yml');

// A missing subject must be a hard failure, not a suite of passing tests against nothing.
if (!existsSync(ACTION)) throw new Error(`FATAL: ${ACTION} is missing`);

interface CompositeAction {
  runs: { steps: Array<{ name?: string; run?: string }> };
}

const action = load(readFileSync(ACTION, 'utf8')) as CompositeAction;
const installStep = action.runs.steps.find(s => typeof s.run === 'string' && s.run.includes('npm install'));
const runBlock = installStep?.run ?? '';

// Scope the flag assertions to the npm invocation itself, never the whole run block.
// Asserting against the block let a COMMENT satisfy them: `toContain('--prefix')` matched
// the sentence explaining why we pass --prefix, and stayed green through an injection that
// replaced the real flag with `-g`. Same for '::warning::', which a commented-out line
// still contains. Found by injecting each mutation one at a time and watching which tests
// reddened - two of the four did not.
const npmCommand = (runBlock.match(/npm install[\s\S]*?(?=\n\s*CODE=)/) ?? [''])[0];

// Comments are what defeated the first version of this file, so strip them before
// asserting on control flow.
const code = runBlock
  .split('\n')
  .filter(line => !line.trim().startsWith('#'))
  .join('\n');

describe('align-check action: how it installs the CLI', () => {
  // Positive control for every assertion below. If the install moved to another mechanism
  // these all become vacuous, so this has to fail loudly rather than the others passing.
  it('installs the CLI with npm, and the command is findable', () => {
    expect(installStep, 'no step runs `npm install` - did the install move?').toBeDefined();
    expect(npmCommand, 'could not isolate the npm command - the parse found nothing').not.toBe('');
    expect(npmCommand).toContain('@aligndottech/cli@');
  });

  it('prunes the optional dependency', () => {
    expect(npmCommand).toContain('--omit=optional');
  });

  it('installs into a prefix rather than globally', () => {
    // `-g` needs a writable npm prefix, which a self-hosted runner may not give us, and
    // this action is published for other people's infrastructure.
    expect(npmCommand).toContain('--prefix');
    expect(npmCommand).not.toMatch(/\s-g\b/);
  });

  it('never exits the step itself, so fail-on keeps ownership of the outcome', () => {
    // An exit here bypasses the policy entirely and turns an npm outage into a merge
    // freeze for everyone on the default `fail-on: conflict`. decide.sh, in a later step,
    // is the only thing allowed to end the job.
    expect(code).not.toMatch(/\bexit\b/);
  });

  it('says so in the log when the install fails, rather than failing silently', () => {
    expect(code).toContain('::warning::');
  });
});
