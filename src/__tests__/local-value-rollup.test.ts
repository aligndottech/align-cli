import { describe, expect, it } from 'vitest';
import { createLocalDb } from '../lib/local-db.js';
import { localValueRollup } from '../lib/value-rollup.js';

function seed(links: Array<{ relation: string }>) {
  const db = createLocalDb(':memory:');
  const a = db.insertDecision({ title: 'A', summary: '', sourceUrl: null, platform: 'cli' });
  const b = db.insertDecision({ title: 'B', summary: '', sourceUrl: null, platform: 'cli' });
  for (const l of links) {
    db.insertLink({ sourceId: a, targetId: b, relation: l.relation, confidence: 1 });
  }
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

    expect(out.decisions).toBe(2);
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
