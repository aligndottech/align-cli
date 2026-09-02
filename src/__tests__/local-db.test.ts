import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';

describe('local-db', () => {
  let dbPath: string;
  let db: ReturnType<typeof createLocalDb> | undefined;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-test-${Date.now()}.db`);
  });

  afterEach(() => {
    db?.close(); // release the SQLite handle so Windows can unlink the file (EBUSY otherwise)
    db = undefined;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('creates schema on init and returns empty decisions list', () => {
    db = createLocalDb(dbPath);
    expect(db.listDecisions()).toEqual([]);
  });

  it('inserts and retrieves a decision', () => {
    db = createLocalDb(dbPath);
    const id = db.insertDecision({
      title: 'Use Postgres for production',
      summary: 'We decided to use PostgreSQL as the primary database',
      sourceUrl: null,
      platform: 'cli',
    });
    const decisions = db.listDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.id).toBe(id);
    expect(decisions[0]!.title).toBe('Use Postgres for production');
  });

  it('stores and retrieves an embedding blob', () => {
    db = createLocalDb(dbPath);
    const id = db.insertDecision({ title: 'T', summary: 'S', sourceUrl: null, platform: 'cli' });
    const embedding = new Float32Array(384).fill(0.5);
    db.setEmbedding(id, embedding);
    const retrieved = db.getEmbedding(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(384);
    expect(retrieved![0]).toBeCloseTo(0.5);
  });

  it('stores an embedding that is a view into a larger buffer (offset != 0)', () => {
    db = createLocalDb(dbPath);
    const id = db.insertDecision({ title: 'T', summary: 'S', sourceUrl: null, platform: 'cli' });
    // Simulate a pooled tensor: a 384-element view starting partway into a bigger buffer
    const backing = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) backing[i] = i;
    const view = backing.subarray(100, 484); // length 384, byteOffset 400
    expect(view.length).toBe(384);
    db.setEmbedding(id, view);
    const retrieved = db.getEmbedding(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(384);
    expect(retrieved![0]).toBeCloseTo(100);
    expect(retrieved![383]).toBeCloseTo(483);
  });

  it('inserts and lists conflict links', () => {
    db = createLocalDb(dbPath);
    const id1 = db.insertDecision({ title: 'Use Postgres', summary: 'Postgres', sourceUrl: null, platform: 'cli' });
    const id2 = db.insertDecision({ title: 'Use MySQL', summary: 'MySQL instead', sourceUrl: null, platform: 'cli' });
    db.insertLink({ sourceId: id1, targetId: id2, relation: 'conflicts_with', confidence: 0.82 });
    const links = db.listLinks({ relation: 'conflicts_with' });
    expect(links).toHaveLength(1);
    expect(links[0]!.sourceId).toBe(id1);
    expect(links[0]!.targetId).toBe(id2);
    expect(links[0]!.relation).toBe('conflicts_with');
  });

  it('getStats returns counts', () => {
    db = createLocalDb(dbPath);
    db.insertDecision({ title: 'T', summary: 'S', sourceUrl: null, platform: 'cli' });
    const stats = db.getStats();
    expect(stats.decisions).toBe(1);
    expect(stats.embeddings).toBe(0);
  });
});

// ALI-796: getAllRefs is the graph-wide read the gap resolver needs - one row per
// (decision, ref), across every decision, so unresolvedGaps can count DISTINCT
// decisions per platform without a per-decision round trip.
describe('getAllRefs', () => {
  it('returns every ref across every decision, with the decision it belongs to', () => {
    const db = createLocalDb(':memory:');
    const a = db.insertDecision({ title: 'A', summary: '', sourceUrl: null, platform: 'git' });
    const b = db.insertDecision({ title: 'B', summary: '', sourceUrl: null, platform: 'git' });
    db.replaceRefs(a, [{ ref: 'ALI-123', platform: 'tracker' }]);
    db.replaceRefs(b, [{ ref: '#45', platform: 'code' }]);
    const all = db.getAllRefs();
    db.close();

    expect(all).toContainEqual({ decisionId: a, ref: 'ALI-123', platform: 'tracker' });
    expect(all).toContainEqual({ decisionId: b, ref: '#45', platform: 'code' });
    expect(all).toHaveLength(2);
  });

  it('returns empty for a graph with no refs', () => {
    const db = createLocalDb(':memory:');
    db.insertDecision({ title: 'A', summary: '', sourceUrl: null, platform: 'git' });
    expect(db.getAllRefs()).toEqual([]);
    db.close();
  });
});

// ALI-796: the payoff half of the gap-driven pull - once the missing source is
// imported, resolve the pre-existing ref into a real graph link.
describe('resolveRefs', () => {
  it('links a citing decision to the newly-ingested decision it names', () => {
    const db = createLocalDb(':memory:');
    const citer = db.insertDecision({ title: 'Switch to JWT', summary: 'Refs ALI-123', sourceUrl: null, platform: 'git' });
    db.replaceRefs(citer, [{ ref: 'ALI-123', platform: 'tracker' }]);

    const jiraDecision = db.insertDecision({
      title: 'ALI-123', summary: '', sourceUrl: 'https://acme.atlassian.net/browse/ALI-123', platform: 'jira',
    });
    db.resolveRefs(jiraDecision, [
      { ref: 'https://acme.atlassian.net/browse/ALI-123', platform: 'jira' },
      { ref: 'ALI-123', platform: 'tracker' },
    ]);

    const links = db.listLinks({ decisionId: jiraDecision });
    db.close();

    expect(links).toContainEqual(
      expect.objectContaining({ sourceId: citer, targetId: jiraDecision, relation: 'relates' }),
    );
  });

  it('does nothing when no existing ref names the candidate identity', () => {
    const db = createLocalDb(':memory:');
    const citer = db.insertDecision({ title: 'Switch to JWT', summary: 'Refs ALI-999', sourceUrl: null, platform: 'git' });
    db.replaceRefs(citer, [{ ref: 'ALI-999', platform: 'tracker' }]);

    const jiraDecision = db.insertDecision({
      title: 'ALI-123', summary: '', sourceUrl: 'https://acme.atlassian.net/browse/ALI-123', platform: 'jira',
    });
    db.resolveRefs(jiraDecision, [
      { ref: 'https://acme.atlassian.net/browse/ALI-123', platform: 'jira' },
      { ref: 'ALI-123', platform: 'tracker' },
    ]);

    expect(db.listLinks({ decisionId: jiraDecision })).toEqual([]);
    db.close();
  });

  it('does not link a decision to itself when its own ref shape happens to match', () => {
    const db = createLocalDb(':memory:');
    const jiraDecision = db.insertDecision({
      title: 'ALI-123', summary: 'Refs ALI-123', sourceUrl: 'https://acme.atlassian.net/browse/ALI-123', platform: 'jira',
    });
    db.replaceRefs(jiraDecision, [{ ref: 'ALI-123', platform: 'tracker' }]);
    db.resolveRefs(jiraDecision, [
      { ref: 'https://acme.atlassian.net/browse/ALI-123', platform: 'jira' },
      { ref: 'ALI-123', platform: 'tracker' },
    ]);

    expect(db.listLinks({ decisionId: jiraDecision })).toEqual([]);
    db.close();
  });

  it('is idempotent: resolving twice does not create a duplicate link', () => {
    const db = createLocalDb(':memory:');
    const citer = db.insertDecision({ title: 'Switch to JWT', summary: 'Refs ALI-123', sourceUrl: null, platform: 'git' });
    db.replaceRefs(citer, [{ ref: 'ALI-123', platform: 'tracker' }]);
    const jiraDecision = db.insertDecision({
      title: 'ALI-123', summary: '', sourceUrl: 'https://acme.atlassian.net/browse/ALI-123', platform: 'jira',
    });
    const candidates = [
      { ref: 'https://acme.atlassian.net/browse/ALI-123', platform: 'jira' },
      { ref: 'ALI-123', platform: 'tracker' },
    ];
    db.resolveRefs(jiraDecision, candidates);
    db.resolveRefs(jiraDecision, candidates);

    const links = db.listLinks({ decisionId: jiraDecision }).filter((l) => l.relation === 'relates');
    db.close();
    expect(links).toHaveLength(1);
  });
});
