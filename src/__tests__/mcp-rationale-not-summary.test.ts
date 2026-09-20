import { describe, expect, it } from 'vitest';

import { shapeDecisionRationale } from '../lib/mcp-timeline-tools.js';

/**
 * ALI-1085, the align-cli half. The hosted connector carried the identical defect and was
 * fixed in align-stack#2454; this is the SAME projection written a second time in a second
 * repo, and it is the one the CLI, every `align mcp --setup` customer, and AlignBench's align
 * arm actually reach.
 *
 * `shapeDecisionRationale` resolved `dj.rationale ?? ai.rationale ?? summary`, so a decision
 * with no captured reasoning had its SUMMARY returned under the name `rationale`. Verified
 * against prod through `align mcp --env prod` on 2026-09-20: for align-frontend#213,
 * `rationale === summary` was true and nothing marked the substitution.
 *
 * That is verification.md's defaulting fallback living in the product: it converts MISSING
 * into something indistinguishable from PRESENT, for a reader that is a model and will repeat
 * the summary to a human as the team's reasoning.
 *
 * Deployment-mode parity is a hard rule here - cloud, self-host and true local-only must carry
 * the same guarantees - so fixing only the hosted connector would have left the CLI and every
 * local-mode user with the defect.
 */
const base = (over: Record<string, unknown> = {}) => ({
  id: 'd-1',
  title: 'Vendor canonical design tokens',
  summary: 'PR establishes parity testing and reconciles token divergences.',
  status: 'active',
  platform: 'github',
  created_at: '2026-09-01T08:49:23.300Z',
  decision_json: {},
  ...over,
});

describe('shapeDecisionRationale does not pass the summary off as the rationale', () => {
  it('omits rationale and says so when none was captured', () => {
    const out = shapeDecisionRationale(base(), 'd-1');

    expect(out['rationale']).toBeUndefined();
    expect(out['rationale_unavailable']).toBe(true);
    // Nothing is withheld - the summary is still there under its own name.
    expect(out['summary']).toBe('PR establishes parity testing and reconciles token divergences.');
  });

  it('never returns a rationale byte-identical to the summary', () => {
    const out = shapeDecisionRationale(base(), 'd-1');
    expect(out['rationale']).not.toBe(out['summary']);
  });

  it('treats an empty-string rationale as absent', () => {
    // `??` does NOT fall through on '', so this shape previously returned an empty rationale
    // and no marker - a third way to say "we have the reasoning" while having none.
    const out = shapeDecisionRationale(base({ decision_json: { rationale: '' } }), 'd-1');
    expect(out['rationale']).toBeUndefined();
    expect(out['rationale_unavailable']).toBe(true);
  });

  // Positive controls: a genuine rationale from either location must survive untouched, or
  // this "fix" would simply have deleted a working field.
  it('returns a real decision_json.rationale unchanged', () => {
    const out = shapeDecisionRationale(base({ decision_json: { rationale: 'Chose X over Y.' } }), 'd-1');
    expect(out['rationale']).toBe('Chose X over Y.');
    expect(out['rationale_unavailable']).toBeUndefined();
  });

  it('returns a real ai.rationale unchanged', () => {
    const out = shapeDecisionRationale(base({ decision_json: { ai: { rationale: 'Scan reasoned W.' } } }), 'd-1');
    expect(out['rationale']).toBe('Scan reasoned W.');
    expect(out['rationale_unavailable']).toBeUndefined();
  });
});
