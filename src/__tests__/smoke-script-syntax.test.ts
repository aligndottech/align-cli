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
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const SHELL_SCRIPTS = ['scripts/smoke-install.sh'];
const NODE_HELPERS = ['scripts/smoke-timeout.mjs', 'scripts/smoke-mcp-handshake.mjs'];

describe('install-smoke scripts parse', () => {
  it.each(SHELL_SCRIPTS)('%s exists and passes bash -n', async (rel) => {
    const abs = join(ROOT, rel);
    expect(existsSync(abs), `${rel} is missing`).toBe(true);
    // bash -n exits non-zero on a syntax error; execFile then rejects.
    await exec('bash', ['-n', abs]);
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
