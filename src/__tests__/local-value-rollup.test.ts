import { describe, expect, it } from 'vitest';
import { createLocalDb } from '../lib/local-db.js';
import { localValueRollup } from '../lib/value-rollup.js';

/**
 * Each link gets its own TARGET decision, so N links are N distinct edges.
 *
 * They used to share one pair, which meant two `duplicates` links were two rows naming the
 * identical (source, target, relation) triple - and `decision_links` now has a unique index on
 * that triple, so the second is an upsert and the count is 1. The rollup counts edges BY
 * RELATION, which is what these tests are about, so the fixture needed distinct edges rather
 * than the assertions needing weakening.
 */
function seed(links: Array<{ relation: string }>) {
  const db = createLocalDb(':memory:');
  const a = db.insertDecision({ title: 'A', summary: '', sourceUrl: null, platform: 'cli' });
  links.forEach((l, i) => {
    const target = db.insertDecision({ title: `T${i}`, summary: '', sourceUrl: null, platform: 'cli' });
    db.insertLink({ sourceId: a, targetId: target, relation: l.relation, confidence: 1 });
  });
  return db;
}

describe('localValueRollup (ALI-215 - honest local subset)', () => {
  it('counts decisions + conflicts + duplicates + supersessions from decision_links', () => {
    const db = seed([
      { relation: 'conflicts_with' },
      { relation: 'duplicates' },
      { relation: 'duplicates' },
      { relation: 'supersedes' },
    ]);
    const out = localValueRollup(db);
    db.close();

    // One source plus one target per link, per `seed` above. Written as the arithmetic rather
        // than as a literal so it stays true if a relation is added to the fixture.
    expect(out.decisions).toBe(1 + 4);
    expect(out.conflictsCaught).toBe(1);
    expect(out.duplicates).toBe(2);
    expect(out.supersessions).toBe(1);
  });

  it('reflects a different link seed (generalization)', () => {
    const db = seed([{ relation: 'supersedes' }, { relation: 'supersedes' }, { relation: 'duplicates' }]);
    const out = localValueRollup(db);
    db.close();

    expect(out.supersessions).toBe(2);
    expect(out.duplicates).toBe(1);
    expect(out.conflictsCaught).toBe(0);
  });

  it('omits reuse rate and health grade (needs the gateway - no offline fabrication)', () => {
    const db = seed([]);
    const out = localValueRollup(db);
    db.close();

    expect(out.reuseRate).toBeNull();
    expect(out.healthGrade).toBeNull();
  });
});

describe('localValueRollup gaps (ALI-796)', () => {
  it('names an unresolved-ref gap when the connector is not connected', () => {
    const db = createLocalDb(':memory:');
    const citer = db.insertDecision({ title: 'A', summary: 'Refs ALI-123', sourceUrl: null, platform: 'git' });
    db.replaceRefs(citer, [{ ref: 'ALI-123', platform: 'tracker' }]);

    const out = localValueRollup(db, () => false);
    db.close();

    expect(out.gaps).toEqual([{ platform: 'tracker', decisions: 1, connectors: ['jira', 'linear'] }]);
  });

  it('omits a gap once its connector is connected', () => {
    const db = createLocalDb(':memory:');
    const citer = db.insertDecision({ title: 'A', summary: 'Refs ALI-123', sourceUrl: null, platform: 'git' });
    db.replaceRefs(citer, [{ ref: 'ALI-123', platform: 'tracker' }]);

    const out = localValueRollup(db, (id) => id === 'jira');
    db.close();

    expect(out.gaps).toEqual([]);
  });

  it('defaults to no gaps when no connection check is given', () => {
    const db = createLocalDb(':memory:');
    const out = localValueRollup(db);
    db.close();
    expect(out.gaps).toEqual([]);
  });
});
