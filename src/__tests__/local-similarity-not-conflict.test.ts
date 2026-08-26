// ALI-503: local mode linked every pair over 0.65 cosine with the relation hardcoded to
// `conflicts_with`, then counted those rows as "conflicts caught" and used the count to
// trigger the pricing upsell. The CLI's own classifier prompt says, two files away, that
// "high textual similarity alone is NOT a conflict", and value-rollup.ts's docstring says
// the offline subset does not fabricate. Both were right and the code did neither.
//
// Cosine similarity is `relates`. Nothing in production writes a conflict link at all, so
// the counter tests below insert one directly - that is the DoD's positive control, and
// without it this fix is indistinguishable from deleting the feature.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.0),
}));

vi.mock('../lib/local-relationship-classifier.js', () => ({
  classifyRelationship: vi.fn().mockResolvedValue({ ok: false, reason: 'no_llm_key' }),
  RELATIONSHIP_TYPES: ['supersedes', 'conflicts_with', 'contradicts', 'duplicates', 'relates'],
}));

import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';
import { cosineSimilarity } from '../lib/local-embeddings.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { localValueRollup, renderValueReadout, type ValueRollup } from '../lib/value-rollup.js';

// ---------------------------------------------------------------- A. the write

describe('ALI-503 the write: cosine similarity is `relates`, never a conflict', () => {
  let dbPath: string;
  let client: ReturnType<typeof createLocalGatewayClient>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-503-${Date.now()}-${Math.trunc(performance.now())}.db`);
    client = createLocalGatewayClient(dbPath);
    // Above CONFLICT/SIMILARITY_THRESHOLD (0.65), so the linking branch is actually reached.
    // A fixture below it would exercise nothing and pass whatever the relation said.
    vi.mocked(cosineSimilarity).mockReturnValue(0.8);
  });

  afterEach(() => {
    client.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${dbPath}${suffix}`;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });

  it('a similar pair produces no conflicts, on the surface an agent reads', async () => {
    // getConflicts backs the MCP tool align_get_conflicts, so this is the worst of the
    // five affected surfaces: an agent took these as adjudicated findings.
    await client.captureDecision('We standardised on Postgres 16 for new services', 'cli');
    await client.captureDecision('Postgres 16 is the default datastore going forward', 'cli');

    expect((await client.getConflicts()).conflict_count).toBe(0);
  });

  it('POSITIVE CONTROL: getConflicts can still report a genuine conflict', async () => {
    // Otherwise the zero above is indistinguishable from a getConflicts that returns
    // nothing whatever the graph holds.
    const only = await client.captureDecision('Adopt gRPC', 'cli');
    const db = createLocalDb(dbPath);
    db.insertLink({ sourceId: only.id, targetId: only.id, relation: 'conflicts_with', confidence: 0.9 });
    db.close();

    expect((await client.getConflicts()).conflict_count).toBe(1);
  });

  it('still writes a link, and writes it as `relates`', async () => {
    // The pair for the first test: a rename must not pass by deleting linking altogether,
    // and asserting the NEW value matters because these readers fail silently empty.
    await client.captureDecision('We standardised on Postgres 16', 'cli');
    const second = await client.captureDecision('Postgres 16 everywhere', 'cli');

    const impact = await client.getImpact(second.id);
    const all = [...impact.upstream, ...impact.downstream];

    expect(all.length).toBeGreaterThan(0);
    expect(all.every(l => l.relation === 'relates')).toBe(true);
  });

  it('ingestBatch reports the relationship it actually wrote', async () => {
    // Two writers of one fact: the row and the returned analysis. They must not diverge.
    const { snapshots } = await client.ingestBatch([
      { raw_text: 'Adopt gRPC for service calls', platform: 'jira' },
      { raw_text: 'gRPC is the standard for service to service', platform: 'jira' },
    ]);

    const related = snapshots.flatMap(s => s.analysis.relatedDecisions);
    expect(related.length).toBeGreaterThan(0);
    expect(related.every(r => r.relationship === 'relates')).toBe(true);
  });
});

// -------------------------------------------------------------- B. the counter

/**
 * One target decision per link, so N links are N distinct edges. They used to share a single
 * (source, target) pair, so two `relates` links were two rows naming one triple - and
 * `decision_links` now has a unique index on (source_id, target_id, relation), which makes the
 * second an upsert. These tests are about counting edges BY RELATION, so the fixture wanted
 * distinct edges rather than the assertions wanting weakening.
 */
function seed(links: Array<{ relation: string }>) {
  const db = createLocalDb(':memory:');
  const source = db.insertDecision({ title: 'D0', summary: '', sourceUrl: null, platform: 'cli' });
  links.forEach((l, i) => {
    const target = db.insertDecision({ title: `T${i}`, summary: '', sourceUrl: null, platform: 'cli' });
    db.insertLink({ sourceId: source, targetId: target, relation: l.relation, confidence: 1 });
  });
  return db;
}

describe('ALI-503 the counter: similarity and conflicts are different numbers', () => {
  it('counts `relates` rows as similar decisions, not as conflicts', () => {
    const db = seed([{ relation: 'relates' }, { relation: 'relates' }]);
    const out = localValueRollup(db);
    db.close();

    expect(out.similarDecisions).toBe(2);
    expect(out.conflictsCaught).toBe(0);
  });

  it('POSITIVE CONTROL: a genuine conflict row IS still counted', () => {
    // The DoD's requirement. Nothing in production writes this row, so it is inserted
    // directly. Without this test a zero above is indistinguishable from a counter that
    // has been broken or deleted, and the fix would be unfalsifiable.
    const db = seed([{ relation: 'conflicts_with' }, { relation: 'contradicts' }]);
    const out = localValueRollup(db);
    db.close();

    expect(out.conflictsCaught).toBe(2);
    expect(out.similarDecisions).toBe(0);
  });
});

// -------------------------------------------------------------- C. the readout

const rollup = (over: Partial<ValueRollup> = {}): ValueRollup => ({
  decisions: 2, conflictsCaught: 0, similarDecisions: 0, duplicates: 0,
  supersessions: 0, reuseRate: null, healthGrade: null, ...over,
});

describe('ALI-503 the readout', () => {
  it('local mode reports similar decisions and no conflict count', () => {
    const out = renderValueReadout(rollup({ similarDecisions: 34 }), { mode: 'local' });

    expect(out).toContain('34 similar decisions');
    // A permanent zero reads as a broken counter, so the line is gone offline entirely.
    expect(out).not.toContain('conflicts caught');
  });

  it('cloud mode still reports conflicts caught', () => {
    // The pair for the test above: this change is scoped to local mode and must not
    // quietly delete a cloud metric that the gateway genuinely adjudicates.
    const out = renderValueReadout(rollup({ conflictsCaught: 7 }), { mode: 'cloud' });

    expect(out).toContain('7 conflicts caught');
  });
});

// ------------------------------------------------------------- D. the upsell gate

describe('ALI-503 the upsell must not be bought by similarity', () => {
  const SHARE = 'Share this graph with your team';

  it('local: shown once the graph has enough decisions to be worth sharing', () => {
    expect(renderValueReadout(rollup({ decisions: 5 }), { mode: 'local' })).toContain(SHARE);
  });

  it('local: not shown below that', () => {
    expect(renderValueReadout(rollup({ decisions: 4 }), { mode: 'local' })).not.toContain(SHARE);
  });

  it('local: similarity alone never buys it', () => {
    // The heart of the ticket applied to the gate. Before this fix 50 cosine artefacts
    // counted as 50 conflicts caught, which made hasValue true and printed the upsell.
    const out = renderValueReadout(rollup({ decisions: 2, similarDecisions: 50 }), { mode: 'local' });
    expect(out).not.toContain(SHARE);
  });

  it('cloud: an adjudicated conflict still earns it', () => {
    expect(renderValueReadout(rollup({ conflictsCaught: 1 }), { mode: 'cloud' })).toContain(SHARE);
  });
});

// ---------------------------------------------------------------- F. the migration

describe('ALI-503 migrating the artefacts already on disk', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-503-mig-${Date.now()}-${Math.trunc(performance.now())}.db`);
  });
  afterEach(() => {
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  /**
   * A database written by an OLDER build, which is the only thing the migration is for.
   * Creating one with the current build will not do: it stamps user_version immediately, so
   * there is correctly nothing to migrate and the test would assert against a precondition
   * it never established. Rewinding the pragma is what actually simulates the old state.
   */
  function seedPreMigrationDb(): { a: string; b: string } {
    const db = createLocalDb(dbPath);
    const a = db.insertDecision({ title: 'A', summary: '', sourceUrl: null, platform: 'cli' });
    const b = db.insertDecision({ title: 'B', summary: '', sourceUrl: null, platform: 'cli' });
    db.insertLink({ sourceId: a, targetId: b, relation: 'conflicts_with', confidence: 0.7 });
    db.close();

    const raw = new Database(dbPath);
    raw.pragma('user_version = 0');
    raw.close();
    return { a, b };
  }

  it('rewrites the fabricated rows already in an existing database', () => {
    // Safe to do unconditionally at version 0 because insertLink had exactly one caller, so
    // every conflicts_with row written by that build is provably a cosine artefact.
    seedPreMigrationDb();

    const after = createLocalDb(dbPath);
    const rolled = localValueRollup(after);
    after.close();

    expect(rolled.conflictsCaught).toBe(0);
    expect(rolled.similarDecisions).toBe(1);
  });

  it('runs ONCE: a genuine conflict written afterwards survives a reopen', () => {
    // The test that separates a one-time migration from a permanent rewrite. An unguarded
    // `UPDATE ... WHERE relation = 'conflicts_with'` on every open passes the test above and
    // then silently eats every earned conflict from here on, with nothing to show for it.
    const { a, b } = seedPreMigrationDb();

    const migrated = createLocalDb(dbPath); // version 0 -> 1, artefact relabelled
    migrated.insertLink({ sourceId: a, targetId: b, relation: 'conflicts_with', confidence: 0.9 });
    migrated.close();

    const reopened = createLocalDb(dbPath);
    const rolled = localValueRollup(reopened);
    reopened.close();

    expect(rolled.conflictsCaught).toBe(1);
    expect(rolled.similarDecisions).toBe(1);
  });

  it('records the schema version so the migration cannot run twice', () => {
    seedPreMigrationDb();
    const db = createLocalDb(dbPath);
    db.close();

    const raw = new Database(dbPath);
    const version = raw.pragma('user_version', { simple: true });
    raw.close();

    // Against the constant, not a literal: the assertion is "migrate() stamped the version it
    // claims to expect", which is what makes the guard work. A hardcoded 1 tested the same
    // property but had to be hand-edited by the next migration, so it failed for a reason that
    // had nothing to do with the behaviour it was written to protect.
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('a fresh database is unaffected', () => {
    const db = createLocalDb(dbPath);
    const rolled = localValueRollup(db);
    db.close();

    expect(rolled.conflictsCaught).toBe(0);
    expect(rolled.similarDecisions).toBe(0);
    expect(rolled.decisions).toBe(0);
  });
});
