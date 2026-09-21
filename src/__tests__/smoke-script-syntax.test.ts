/**
 * The install-smoke scripts must parse before CI ever runs them.
 *
 * scripts/smoke-install.sh is executed by the `install-smoke` CI job on three
 * operating systems. A bash syntax error there fails nine matrix legs at once,
 * and bash parses incrementally, so a stray token after an `exit` ships silently
 * (the same defect action-shell-syntax.test.ts exists for). `bash -n` parses
 * without executing; `node --check` is the same gate for the .mjs helpers.
 *
 * This is a parse gate only. Whether the smoke *finds* anything is proven by
 * the inject-and-revert run recorded in the PR that added it, not here.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const SHELL_SCRIPTS = ['scripts/smoke-install.sh'];

/**
 * DERIVED from scripts/, not listed (ALI-1135). The hand-written list had exactly the failure
 * mode this suite exists to prevent: smoke-mcp-config-spawn.mjs was added, wired into CI, and
 * silently not parse-checked, because nothing goes red when a list is one entry short. A
 * review bot caught it. Reading the directory makes the next helper covered on arrival.
 */
const NODE_HELPERS = readdirSync(join(ROOT, 'scripts'))
  .filter((f) => f.endsWith('.mjs'))
  .sort()
  .map((f) => `scripts/${f}`);

describe('install-smoke scripts parse', () => {
  it.each(SHELL_SCRIPTS)('%s exists and passes bash -n', async (rel) => {
    const abs = join(ROOT, rel);
    expect(existsSync(abs), `${rel} is missing`).toBe(true);
    // bash -n exits non-zero on a syntax error; execFile then rejects.
    await exec('bash', ['-n', abs]);
  });

  // A glob that matched nothing would make every assertion below vacuous, so the count is
  // asserted before the parse (verification.md: a zero-match parse must raise, never pass).
  it('finds the .mjs helpers to check at all', () => {
    expect(NODE_HELPERS.length).toBeGreaterThanOrEqual(3);
    expect(NODE_HELPERS).toContain('scripts/smoke-mcp-config-spawn.mjs');
  });

  it.each(NODE_HELPERS)('%s exists and passes node --check', async (rel) => {
    const abs = join(ROOT, rel);
    expect(existsSync(abs), `${rel} is missing`).toBe(true);
    await exec(process.execPath, ['--check', abs]);
  });

  it('the CI workflow runs the smoke script it gates on', async () => {
    // The job is only real if it invokes the script this suite parses - a renamed
    // script with a stale workflow reference passes bash -n and runs nothing.
    const { readFileSync } = await import('node:fs');
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('scripts/smoke-install.sh');
  });
});
