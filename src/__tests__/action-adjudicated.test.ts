/**
 * Truth table for the adjudication override (.github/actions/align-check/adjudicated.sh).
 *
 * This is the only step in the chain that can turn a FAILING gate green, so its whole job is
 * to be hard to satisfy by accident. Every malformed, absent or unexpected input must read as
 * "no answer", because the alternative is a build that goes green because a parse broke.
 *
 * Running the real script rather than reimplementing it: a test that validates a copy proves
 * nothing about what runs (the lesson decide.sh's own suite was written for).
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const exec = promisify(execFile);
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../.github/actions/align-check/adjudicated.sh',
);

// A missing script must be a hard failure, not a suite of passes against nothing.
if (!existsSync(SCRIPT)) throw new Error(`FATAL: ${SCRIPT} is missing`);

// `args` rather than a single string, so a test can omit the argument entirely rather than
// only passing an empty one. The script distinguishes the two ($1 unset vs empty) and both
// have to land on a refusal, so both are exercised.
async function adjudicated(...args: string[]): Promise<{ exitCode: number; out: string }> {
  try {
    const { stdout } = await exec('bash', [SCRIPT, ...args]);
    return { exitCode: 0, out: stdout.trim() };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: e.code ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
}

const accepted = JSON.stringify({
  status: 'unknown',
  reason: 'unclassified_relation',
  reason_class: 'non_verdict',
  prior_adjudication: { verdict: 'accepted', adjudicatedBy: 'u-1', checkEventId: 'e-1' },
});

describe('adjudication override', () => {
  it('accepts a non-verdict a human accepted', async () => {
    const res = await adjudicated(accepted);
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain('adjudicated=yes');
  });

  // The second example for the same rule, so a script that always exits 0 cannot pass both.
  it('refuses the same shape when no adjudication is present', async () => {
    const res = await adjudicated(
      JSON.stringify({ status: 'unknown', reason_class: 'non_verdict' }),
    );
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain('adjudicated=no');
  });

  // A human saying "this IS a conflict" must not read as an acceptance just because an
  // adjudication exists. This is the inversion that would matter most in production.
  it('refuses when the human answered conflicting', async () => {
    const res = await adjudicated(
      JSON.stringify({
        status: 'unknown',
        reason_class: 'non_verdict',
        prior_adjudication: { verdict: 'conflicting' },
      }),
    );
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain('verdict=conflicting');
  });

  // An OUTAGE is not adjudicable. Accepting an adjudication against reason_class=unavailable
  // would let one stale human answer excuse every future timeout on that content, which is
  // exactly the fail-open ALI-348 exists to prevent.
  it('refuses an accepted verdict when the class is unavailable', async () => {
    const res = await adjudicated(
      JSON.stringify({
        status: 'unknown',
        reason_class: 'unavailable',
        prior_adjudication: { verdict: 'accepted' },
      }),
    );
    expect(res.exitCode).toBe(1);
    expect(res.out).toContain('class=unavailable');
  });

  describe('every broken input reads as no answer', () => {
    it('no argument at all', async () => {
      expect(await adjudicated()).toMatchObject({ exitCode: 1 });
    });

    // Its own case, because `${1:-}` and an explicitly empty `$1` reach the guard by
    // different routes and only one of them was covered while this pair was one test.
    it('an explicitly empty argument', async () => {
      expect(await adjudicated('')).toMatchObject({ exitCode: 1 });
    });

    it('not JSON', async () => {
      expect(await adjudicated('this is not json')).toMatchObject({ exitCode: 1 });
    });

    it('JSON that is not an object', async () => {
      expect(await adjudicated('[1,2,3]')).toMatchObject({ exitCode: 1 });
    });

    it('null prior_adjudication', async () => {
      const res = await adjudicated(
        JSON.stringify({ reason_class: 'non_verdict', prior_adjudication: null }),
      );
      expect(res.exitCode).toBe(1);
    });

    // A verdict carrying whitespace would break the two-field read this script does, and a
    // split value could land 'accepted' in the class slot. Closed vocabulary, so anything
    // with whitespace is malformed by construction.
    it('a verdict containing whitespace', async () => {
      const res = await adjudicated(
        JSON.stringify({
          reason_class: 'non_verdict',
          prior_adjudication: { verdict: 'accepted extra' },
        }),
      );
      expect(res.exitCode).toBe(1);
    });
  });

  // The CLI prints its JSON as the last line and may print other lines first, so the parse
  // must take the last line rather than assume the stream is one object.
  it('reads the LAST line when the CLI printed something before its JSON', async () => {
    const res = await adjudicated(`some preamble\n${accepted}`);
    expect(res.exitCode).toBe(0);
  });
});
