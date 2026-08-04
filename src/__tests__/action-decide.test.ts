/**
 * Truth table for the GitHub Action's fail policy (.github/actions/align-check/decide.sh).
 *
 * This exists because the policy shipped wrong. Inline in action.yml it classified on the
 * exit code alone, so a CLI crash - which also exits 1, with no JSON - was reported as
 * "found a conflict with a recorded decision". Verified against the published 0.8.1, which
 * predates --base: `npx @aligndottech/cli@0.8.1 check --ci --base origin/main` exits 1 with
 * empty stdout. Any adopter on an older CLI would have seen a fabricated conflict.
 *
 * Running the real script rather than reimplementing its logic here - a test that validates
 * a copy proves nothing about what runs.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../.github/actions/align-check/decide.sh');

// A missing script must be a hard failure, not a suite of passing tests against nothing.
if (!existsSync(SCRIPT)) throw new Error(`FATAL: ${SCRIPT} is missing`);

async function decide(code: string, status: string, failOn: string): Promise<{ exitCode: number; out: string }> {
  try {
    const { stdout } = await exec('bash', [SCRIPT, code, status, failOn]);
    return { exitCode: 0, out: stdout.trim() };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: e.code ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
}

describe('align-check action fail policy', () => {
  describe('fail-on=conflict (the default)', () => {
    it('passes a clean check', async () => {
      expect(await decide('0', 'aligned', 'conflict')).toMatchObject({ exitCode: 0 });
    });

    it('fails on a real conflict', async () => {
      const r = await decide('1', 'conflicting', 'conflict');
      expect(r.exitCode).toBe(1);
      expect(r.out).toContain('reason=conflict');
    });

    it('does NOT call a crash a conflict', async () => {
      // The defect. Exit 1 with no parseable status is a CLI that fell over, not a finding.
      const r = await decide('1', 'error', 'conflict');
      expect(r.exitCode).toBe(0);
      expect(r.out).toContain('incomplete');
      expect(r.out).not.toContain('reason=conflict');
    });

    it('does not block when the check could not run', async () => {
      const r = await decide('2', 'unknown', 'conflict');
      expect(r.exitCode).toBe(0);
      expect(r.out).toContain('incomplete');
    });

    it('treats an unexpected non-zero code as incomplete, not as a pass', async () => {
      const r = await decide('127', 'error', 'conflict');
      expect(r.exitCode).toBe(0);
      expect(r.out).toContain('incomplete');
    });

    // The 401 shape, and the one most likely to be hit in practice - a missing or wrong
    // token. The CLI catches the transport error and exits ZERO with status "error":
    //
    //   $ ALIGN_TOKEN=bad align check --ci --base origin/main
    //   {"status":"error","message":"Gateway returned 401 for /alignment/check: unauthorized"}
    //   EXIT=0
    //
    // Exit code alone would read that as a clean pass. Only the status distinguishes it,
    // which is why `is_incomplete` tests both. Added after a review asked whether a 401
    // could fail the job: it cannot, and this is what pins that it also cannot silently
    // masquerade as "aligned".
    it('treats a zero exit with an error status as incomplete, not as a pass', async () => {
      const r = await decide('0', 'error', 'conflict');
      expect(r.exitCode).toBe(0);
      expect(r.out).toContain('incomplete');
      expect(r.out).not.toContain('outcome=pass status=');
    });

    // `no-context` is the CLI saying it RAN and found no related decisions. That is a
    // result, not a failure to produce one. It exits 0 and is not an error shape, so
    // reporting "nothing was verified" against it is simply false - the diff was checked
    // and the graph had nothing to say about it.
    it('reports no-context as a real result, not as an incomplete check', async () => {
      const r = await decide('0', 'no-context', 'conflict');
      expect(r.exitCode).toBe(0);
      expect(r.out).not.toContain('incomplete');
    });
  });

  describe('fail-on=conflict-or-unknown (strict)', () => {
    it('passes a clean check', async () => {
      expect(await decide('0', 'aligned', 'conflict-or-unknown')).toMatchObject({ exitCode: 0 });
    });

    it('fails on a conflict', async () => {
      const r = await decide('1', 'conflicting', 'conflict-or-unknown');
      expect(r.exitCode).toBe(1);
      expect(r.out).toContain('reason=conflict');
    });

    it('fails when the check could not run, and says so rather than claiming a conflict', async () => {
      const r = await decide('2', 'unknown', 'conflict-or-unknown');
      expect(r.exitCode).toBe(1);
      expect(r.out).toContain('reason=incomplete');
    });

    it('fails on a crash, attributed as incomplete', async () => {
      const r = await decide('1', 'error', 'conflict-or-unknown');
      expect(r.exitCode).toBe(1);
      expect(r.out).toContain('reason=incomplete');
    });

    // The case that broke align-stack#1482. Under the strict policy a `no-context` result
    // failed a REQUIRED check, so any PR touching ground the graph has no decisions about
    // was blocked. "We checked and found nothing related" is the ordinary outcome for new
    // work; it is not an outage.
    it('passes on no-context, which is a complete check that found nothing', async () => {
      const r = await decide('0', 'no-context', 'conflict-or-unknown');
      expect(r.exitCode).toBe(0);
      expect(r.out).toContain('outcome=pass');
      expect(r.out).not.toContain('incomplete');
    });

    // The regression guard for the above, and the reason this pair has to sit together:
    // widening what counts as complete must NOT re-open the fail-open hole that the
    // `unknown` status exists to close (align-cli#76). Same policy, same exit-0 CLI, and
    // this one must still block.
    it('still fails on unknown, so widening no-context did not loosen the strict policy', async () => {
      const r = await decide('0', 'unknown', 'conflict-or-unknown');
      expect(r.exitCode).toBe(1);
      expect(r.out).toContain('reason=incomplete');
    });

    // A passing status with a non-zero exit is INCOHERENT - the CLI does not produce it.
    // These pin the `[ "$CODE" = "0" ]` half of is_complete_pass, which deleting left every
    // other test green: without them the guard is a living mutant, and a future CLI whose
    // exit semantics drift (or a half-parsed JSON line) would be read as a clean pass on
    // the strength of the status string alone. Two examples, one per accepted status, so
    // the rule is the code check rather than one hard-coded pair.
    it.each([
      ['1', 'aligned'],
      ['2', 'no-context'],
    ])('does not accept a passing status with a non-zero exit (code %s, status %s)', async (code, status) => {
      const r = await decide(code, status, 'conflict-or-unknown');
      expect(r.exitCode).toBe(1);
      expect(r.out).toContain('reason=incomplete');
    });
  });

  describe('fail-on=never', () => {
    it.each([
      ['0', 'aligned'],
      ['1', 'conflicting'],
      ['2', 'unknown'],
      ['1', 'error'],
    ])('never fails the job (code %s, status %s)', async (code, status) => {
      expect(await decide(code, status, 'never')).toMatchObject({ exitCode: 0 });
    });
  });

  describe('misuse', () => {
    it('rejects an unknown fail-on rather than silently passing', async () => {
      const r = await decide('0', 'aligned', 'sometimes');
      expect(r.exitCode).toBe(2);
      expect(r.out).toContain('unknown fail-on');
    });

    it('rejects missing arguments', async () => {
      const r = await decide('', '', 'conflict');
      expect(r.exitCode).toBe(2);
    });
  });
});
