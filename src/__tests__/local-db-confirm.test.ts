/**
 * ALI-808: `markConfirmed` writes the columns local-db.ts's DecisionRow already reserves
 * for the session importer ("Confirm is written by the session importer (ALI-808); ratify
 * is the human act below" - local-db.ts's own DecisionRow doc). Kept in its own file rather
 * than folded into local-db-provenance.test.ts (ALI-831's), since this is the one small,
 * additive exception to ALI-808's "does not touch local-db.ts" boundary - see the PR
 * description for why: the columns exist and are documented as this ticket's to write, but
 * no insert path threads them yet.
 *
 * Mirrors markRatified's own test shape exactly (local-db-provenance.test.ts) - same file,
 * same sibling method, same conventions.
 *
 * Test List:
 * 1. writes confirmed_by and confirmed_at and returns the stamp
 * 2. a missing id returns null, changes nothing
 * 3. does not touch decider_kind, ratified_by or ratified_at - confirm is its own act
 */
import { describe, expect, it } from 'vitest';
import { createLocalDb } from '../lib/local-db.js';

describe('markConfirmed', () => {
  it('writes confirmed_by and confirmed_at and returns the stamp', () => {
    const db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 'Fold the one-line fix into my PR', summary: 's', sourceUrl: null, platform: 'agent-session', deciderKind: 'agent' });
    const stamp = db.markConfirmed(id, 'tom@align.tech');
    expect(stamp).not.toBeNull();
    const row = db.getDecisionById(id);
    expect(row?.confirmedBy).toBe('tom@align.tech');
    expect(row?.confirmedAt).toBe(stamp!.confirmedAt);
    expect(row?.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns null for an id the graph does not hold, and changes nothing', () => {
    const db = createLocalDb(':memory:');
    expect(db.markConfirmed('nope', 'tom@align.tech')).toBeNull();
  });

  it('does not touch decider_kind, ratified_by or ratified_at - confirm is a separate act from ratify', () => {
    const db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 'Agent claim', summary: 's', sourceUrl: null, platform: 'agent-session', deciderKind: 'agent' });
    db.markConfirmed(id, 'tom@align.tech');
    const row = db.getDecisionById(id);
    expect(row?.deciderKind).toBe('agent');
    expect(row?.ratifiedBy).toBeNull();
    expect(row?.ratifiedAt).toBeNull();
  });
});
