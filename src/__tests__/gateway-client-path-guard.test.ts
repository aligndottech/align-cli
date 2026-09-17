import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { encodePathSegment, GatewayError } from '../lib/gateway-client.js';

/**
 * Every value interpolated into a request PATH must go through `encodePathSegment`.
 *
 * This is a ratchet rather than a review habit because the review habit already failed twice on
 * one branch. #296 sent an agent-controlled id raw. Round 1 of the follow-up swept for "sites
 * that already call encodeURIComponent" and fixed those, which is the wrong population - it
 * cannot see a site that encodes nothing. Round 3 swept for "sites that interpolate" and found
 * two more agent-reachable paths (`align_get_impact`, `align_check_drift`) still raw. The
 * guarded set was then a hand-maintained list in two places, the call sites and a per-method
 * test table, with nothing deriving either from the source - so a seventh method added later
 * gets no guard, no test, and a green suite.
 *
 * Measured against live prod, which is why this is worth a source-text test:
 *
 *   GET /health                        -> 200   (control: reachable, unauthenticated)
 *   GET /snapshots/../../health        -> 200   <- traversal REACHES another route
 *   GET /snapshots/..%2F..%2Fhealth    -> 401   (both %2F and %2f: proxy keeps it literal)
 *
 * The first two lines are the defect, end to end, against the real gateway rather than through
 * `new URL()`. The third is why encoding the segment is sufficient at the boundary.
 *
 * A source-text assertion has two known costs, stated rather than discovered later: it is
 * incompatible with mutation testing by construction (mutating the source changes the subject),
 * and it can only see the shapes its pattern matches. The pattern below is therefore anchored
 * on BOTH template forms this file uses, and the positive control fails the test if it stops
 * seeing the sites it is supposed to be checking.
 */

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'gateway-client.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

/**
 * Path-segment interpolations that are deliberately NOT guarded, each with the reason.
 *
 * SHRINK-ONLY. Adding an entry means a new unguarded path interpolation, which is the thing
 * this test exists to stop - so an addition needs the reason written here and read by a human,
 * not a number bumped. Every entry below takes a value supplied by the PAT HOLDER (a CLI
 * argument) or by the gateway's own prior response, never by an agent: traversal there aims the
 * principal at their own tenant and crosses no boundary. Verified by entry point, not by shape:
 * the MCP dispatch arms reach only searchDecisions, captureDecision, checkAlignment, checkDrift,
 * getImpact, getConflicts, getTopicTimeline, getDecision and getDecisionTimeline, and the four
 * of those that put a value in a path segment are all guarded.
 */
const UNGUARDED_ALLOWLIST: Array<{ path: string; why: string }> = [
  { path: '/integrations/${key}/health', why: 'connector key from a CLI argument, not an agent' },
  { path: '/integrations/${key}/enable', why: 'connector key from a CLI argument, not an agent' },
  { path: '/integrations/${key}/disable', why: 'connector key from a CLI argument, not an agent' },
  { path: '/oauth/cli-start/${key}', why: 'connector key from a CLI argument, not an agent' },
  { path: '/import/jobs/${job.id}/start', why: "id from startImportJob's own response" },
  { path: '/import/scan-runs/${scanRunId}', why: 'getScanRun has no caller in src/ at all' },
  { path: '/import/jobs/${jobId}/stream', why: 'job id from the gateway response; SSE, same flow' },
];

/** Strip the interpolated expressions so an allowlist entry matches by SHAPE, not by spacing. */
const shapeOf = (text: string) => {
  const m = /`([^`]*)`/.exec(text);
  return m ? m[1]! : text;
};

/**
 * Interpolations that reach a request path, in either form this file writes:
 *   `/snapshots/${...}`            - a path-only template
 *   `${gatewayUrl}/import/...`     - an absolute template
 * The second is the shape a first attempt at this sweep could not see, so it is matched
 * explicitly rather than relied upon to look like the first.
 */
function pathInterpolations(): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  SRC.split('\n').forEach((raw, i) => {
    const text = raw.trim();
    // A COMMENT is not code. The guard's own docblock spells out the three defective URL shapes
    // it exists to prevent, so a sweep that reads comments reports its own explanation as the
    // defect - the same way a guard asserting a config section is absent went red on the
    // comment saying why it is absent. Skipped by construction, not by pattern luck.
    if (text.startsWith('*') || text.startsWith('//') || text.startsWith('/*')) return;

    const hasPathTemplate = /`(\/[A-Za-z0-9._~/-]*)?\$\{/.test(text) || /`\$\{gatewayUrl\}/.test(text);
    if (!hasPathTemplate) return;

    // A template with NO literal `/` outside its interpolations is not a segment: it is the
    // request funnel `${gatewayUrl}${path}`, which receives a path its caller already built and
    // encoded. Treating it as a violation would demand encoding an entire path, which would
    // escape the separators that are supposed to be there.
    const literalOnly = shapeOf(text).replace(/\$\{[^}]*\}/g, '');
    if (!literalOnly.includes('/')) return;

    // A value in the QUERY STRING cannot change which route is reached. `?` before the first
    // interpolation means every interpolation on the line is query-side.
    const firstInterp = text.indexOf('${');
    const q = text.indexOf('?');
    if (q >= 0 && q < firstInterp) return;
    out.push({ line: i + 1, text });
  });
  return out;
}

describe('every request path segment is guarded (ALI-1070 rounds 2 and 3)', () => {
  it('sees the guarded call sites - positive control, so a blind sweep cannot report clean', () => {
    // Without this, a pattern that matched nothing would report zero violations and pass
    // forever. The six guarded sites are the thing the sweep must be able to see.
    const guarded = SRC.split('\n').filter((l) => l.includes('encodePathSegment('));
    // 6 call sites + the definition + the export = the definition and export are not calls.
    const callSites = guarded.filter((l) => !l.includes('export function'));
    expect(callSites.length, 'the sweep can no longer see the guarded sites').toBeGreaterThanOrEqual(6);
    expect(pathInterpolations().length, 'the path-interpolation sweep matched nothing').toBeGreaterThan(5);
  });

  it('has no unguarded path interpolation outside the allowlist', () => {
    const offenders = pathInterpolations().filter((entry) => {
      if (entry.text.includes('encodePathSegment(')) return false;
      const shape = shapeOf(entry.text);
      return !UNGUARDED_ALLOWLIST.some((a) => shape.includes(a.path.replace('${gatewayUrl}', '')));
    });
    expect(
      offenders,
      `Unguarded path interpolation. Wrap the segment in encodePathSegment(), or add it to
UNGUARDED_ALLOWLIST with the reason it cannot be reached by an agent:
${offenders.map((o) => `  gateway-client.ts:${o.line}  ${o.text}`).join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the allowlist shrink-only, so a new raw site cannot hide in it', () => {
    // The count is the ratchet. A new entry is a deliberate act with a reason a human read.
    expect(UNGUARDED_ALLOWLIST).toHaveLength(7);
    for (const entry of UNGUARDED_ALLOWLIST) {
      expect(entry.why.length, `${entry.path} has no reason`).toBeGreaterThan(20);
    }
  });
});

describe('encodePathSegment refuses what encoding cannot fix', () => {
  // The guard's own contract, pinned separately from the sweep above. The sweep proves every
  // site calls it; these prove calling it is worth something.
  it.each(['.', '..', '', '   ', '%2E%2E', '%2e%2e', '.%2e', '%2e.'])(
    'refuses %j, which URL normalisation would resolve away',
    (bad) => {
      expect(() => encodePathSegment(bad)).toThrow(GatewayError);
    },
  );

  it('encodes a traversal that carries its own separators, rather than refusing it', () => {
    // `../../auth/me?` is NOT caught by the dot check - it is stopped by the ENCODING, because
    // the separators and the `?` become %2F and %3F and can no longer truncate the path. The
    // review noted this case had no assertion; without one, the dot check reads as the whole
    // control when it is the smaller half.
    const encoded = encodePathSegment('../../auth/me?');
    expect(encoded).toBe('..%2F..%2Fauth%2Fme%3F');
    expect(new URL(`https://api.example.test/decisions/${encoded}/impact`).pathname).toBe(
      '/decisions/..%2F..%2Fauth%2Fme%3F/impact',
    );
  });

  it('reports a lone surrogate as a rejected id, not as a raw URIError', () => {
    // Fail direction was already CLOSED - encodeURIComponent throws and nothing is sent. But the
    // template is evaluated before `request()` is entered, so the URIError escaped past its catch
    // and surfaced as a crash rather than as "that is not a decision id".
    let thrown: unknown;
    try {
      encodePathSegment('\ud800');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    expect((thrown as GatewayError).message).toContain('not valid');
    // The negative control for this case: it must still be a refusal, never a value.
    expect(() => encodePathSegment('\ud800')).toThrow();
  });

  it('passes a real id through unchanged, so the guard is not refusing everything', () => {
    // The negative control. A guard that threw on every input would satisfy every assertion
    // above and break the client outright.
    expect(encodePathSegment('d-1a2b3c')).toBe('d-1a2b3c');
    expect(encodePathSegment('01JC9Z8Q')).toBe('01JC9Z8Q');
  });
});
