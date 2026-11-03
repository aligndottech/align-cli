/**
 * The action must not pass when it has no credentials (pagewell-uk/disputes, 3 Nov 2026):
 * ALIGN_TOKEN unset -> `token` empty -> the CLI answered "Align is not set up on this
 * machine" (status error, exit 2) -> decide.sh classed it as an incomplete check and the
 * default fail-on=conflict let the job go GREEN. A required check that passes with no
 * credentials is fail-open: an expired secret silently passes every PR.
 *
 * Runs the real scripts, not a copy of their logic.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../.github/actions/align-check');
const REQUIRE = join(DIR, 'require-config.sh');
const DECIDE = join(DIR, 'decide.sh');

async function run(script: string, args: string[]): Promise<{ exitCode: number; out: string }> {
  try {
    const { stdout, stderr } = await exec('bash', [script, ...args]);
    return { exitCode: 0, out: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: e.code ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
}

// require-config.sh <token> <gateway-url> <allow-unconfigured>
describe('align-check require-config', () => {
  it('the script exists', () => {
    expect(existsSync(REQUIRE)).toBe(true);
  });

  it('fails with a named ::error:: when the token is empty on Align cloud', async () => {
    const r = await run(REQUIRE, ['', '', 'false']);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain('::error::');
    expect(r.out).toContain('ALIGN_TOKEN is empty');
    expect(r.out).toContain('Nothing was checked');
  });

  it('fails on a whitespace-only token', async () => {
    expect((await run(REQUIRE, ['   ', '', 'false'])).exitCode).toBe(1);
  });

  it('passes when a token is present', async () => {
    const r = await run(REQUIRE, ['tok-present', '', 'false']);
    expect(r.out).not.toContain('::error::');
    expect(r.exitCode).toBe(0);
  });

  it('passes with no token when a gateway-url is set (self-hosted or local, may not authenticate)', async () => {
    const r = await run(REQUIRE, ['', 'http://localhost:8080', 'false']);
    expect(r.out).not.toContain('::error::');
    expect(r.exitCode).toBe(0);
  });

  it('allow-unconfigured=true downgrades to a warning and passes', async () => {
    const r = await run(REQUIRE, ['', '', 'true']);
    expect(r.out).toContain('::warning::');
    expect(r.out).not.toContain('::error::');
    expect(r.exitCode).toBe(0);
  });

  it('treats an unknown allow-unconfigured value as false', async () => {
    expect((await run(REQUIRE, ['', '', 'yes'])).exitCode).toBe(1);
  });
});

describe('decide.sh with a token present (behaviour must not change)', () => {
  it('transient incomplete still passes under fail-on=conflict', async () => {
    const r = await run(DECIDE, ['2', 'unknown', 'conflict']);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('incomplete-not-enforced');
  });

  it('a conflict still fails per fail-on', async () => {
    const r = await run(DECIDE, ['1', 'conflicting', 'conflict']);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain('reason=conflict');
  });
});
