import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refIdentityFor } from '../lib/decision-refs.js';
import { deleteDecisionWithDependents } from '../lib/local-db-migrate.js';
import { createLocalDb } from '../lib/local-db.js';

// Links made from an exact reference (local-ref-links.ts): certain, both directions, never
// deleted by a model path.

const LINEAR = 'https://linear.app/acme/issue/APP-123/queue-retries';
let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'align-ref-')); path = join(dir, 'graph.db'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Every link row, with the detector stamp the db API does not return. */
function rows(): Array<{ source: string; target: string; relation: string; v: string }> {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare('SELECT source_id AS source, target_id AS target, relation, detector_version AS v FROM decision_links ORDER BY source_id, target_id, relation').all() as never;
  } finally { raw.close(); }
}

function ticket(db: ReturnType<typeof createLocalDb>, url = LINEAR, repo: string | null = null): string {
  const id = db.insertDecision({ title: 'APP-123', summary: 'Retry the queue', sourceUrl: url, platform: url.includes('linear') ? 'linear' : 'github', repo });
  db.resolveRefs(id, refIdentityFor(url.includes('linear') ? 'linear' : 'github', url), []);
  return id;
}

function commit(db: ReturnType<typeof createLocalDb>, refs: Array<{ ref: string; platform: string }>, repo: string | null = null): string {
  const id = db.insertDecision({ title: 'Retry three times', summary: 'Fixes it', sourceUrl: null, platform: 'git', repo });
  db.replaceRefs(id, refs);
  db.resolveRefs(id, [], refs);
  return id;
}

describe('a link from an exact reference', () => {
  it('is made when the cited item arrives second, and is stamped certain', () => {
    const db = createLocalDb(path);
    const c = commit(db, [{ ref: 'APP-123', platform: 'tracker' }]);
    const t = ticket(db);
    db.close();
    expect(rows()).toEqual([{ source: c, target: t, relation: 'relates', v: 'ref' }]);
  });

  it('is made when the citing item arrives second: import order does not matter', () => {
    const db = createLocalDb(path);
    const t = ticket(db);
    const c = commit(db, [{ ref: 'APP-123', platform: 'tracker' }]);
    db.close();
    expect(rows()).toEqual([{ source: c, target: t, relation: 'relates', v: 'ref' }]);
  });

  it('is not made for a ref nothing in the graph is', () => {
    const db = createLocalDb(path);
    ticket(db);
    commit(db, [{ ref: 'APP-999', platform: 'tracker' }]);
    db.close();
    expect(rows()).toEqual([]);
  });

  it('survives a model verdict on the pair: replaceLink keeps it and adds the verdict beside it', () => {
    const db = createLocalDb(path);
    const c = commit(db, [{ ref: 'APP-123', platform: 'tracker' }]);
    const t = ticket(db);
    db.replaceLink({ sourceId: c, targetId: t, relation: 'conflicts_with', confidence: 0.7, detectorVersion: 'v1' });
    db.close();
    expect(rows()).toEqual([
      { source: c, target: t, relation: 'conflicts_with', v: 'v1' },
      { source: c, target: t, relation: 'relates', v: 'ref' },
    ]);
  });

  it('a guessed link is still replaced by a verdict, as before (control)', () => {
    const db = createLocalDb(path);
    const a = db.insertDecision({ title: 'A', summary: 'a', sourceUrl: null, platform: 'git' });
    const b = db.insertDecision({ title: 'B', summary: 'b', sourceUrl: null, platform: 'git' });
    db.insertLink({ sourceId: a, targetId: b, relation: 'relates', confidence: 0.7 });
    db.replaceLink({ sourceId: a, targetId: b, relation: 'supersedes', confidence: 0.9, detectorVersion: 'v1' });
    db.close();
    expect(rows()).toEqual([{ source: a, target: b, relation: 'supersedes', v: 'v1' }]);
  });

  it('upgrades a guessed link on the same pair to certain, and a later guess never downgrades it', () => {
    const db = createLocalDb(path);
    const c = commit(db, [{ ref: 'APP-123', platform: 'tracker' }]);
    const t = db.insertDecision({ title: 'APP-123', summary: 'Retry the queue', sourceUrl: LINEAR, platform: 'linear' });
    db.insertLink({ sourceId: c, targetId: t, relation: 'relates', confidence: 0.5 });
    db.resolveRefs(t, refIdentityFor('linear', LINEAR), []);
    db.insertLink({ sourceId: c, targetId: t, relation: 'relates', confidence: 0.5 });
    db.close();
    expect(rows()).toEqual([{ source: c, target: t, relation: 'relates', v: 'ref' }]);
  });
});

describe('a bare #N is one item only within one repo', () => {
  const PR = 'https://github.com/o/a/pull/12';
  it.each([
    ['the same repo', 'o/a', 'o/a', 1],
    ['an unknown repo on one side', null, 'o/a', 1],
    ['two different repos', 'o/b', 'o/a', 0],
  ])('%s', (_name, commitRepo, prRepo, expected) => {
    const db = createLocalDb(path);
    ticket(db, PR, prRepo);
    commit(db, [{ ref: '#12', platform: 'code' }], commitRepo);
    db.close();
    expect(rows()).toHaveLength(expected);
  });
});

describe('a deleted decision', () => {
  it('takes its identities with it, so a later citer links nothing', () => {
    const db = createLocalDb(path);
    const t = ticket(db);
    db.close();
    // Foreign keys off, so the explicit cleanup is what is tested: node:sqlite turns them on by
    // default, and a cascade would make this pass with the cleanup removed.
    const raw = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    deleteDecisionWithDependents(raw, t);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM decision_identities').get() as { n: number }).n).toBe(0);
    raw.close();
    const again = createLocalDb(path);
    commit(again, [{ ref: 'APP-123', platform: 'tracker' }]);
    again.close();
    expect(rows()).toEqual([]);
  });
});

describe('an existing graph, opened by this version for the first time', () => {
  it('records every identity, links refs in both directions, and stamps the old exact-match links', () => {
    // Build a graph as the previous version left it: no identities table, one exact-match link
    // stored as a guess ('v0'), and one citation the old one-way resolver could never resolve.
    const db = createLocalDb(path);
    const t = db.insertDecision({ title: 'APP-123', summary: 'Retry the queue', sourceUrl: LINEAR, platform: 'linear' });
    const oldCiter = db.insertDecision({ title: 'Old', summary: 'Refs APP-123', sourceUrl: null, platform: 'git' });
    db.replaceRefs(oldCiter, [{ ref: 'APP-123', platform: 'tracker' }]);
    db.insertLink({ sourceId: oldCiter, targetId: t, relation: 'relates', confidence: 1.0 });
    const lateCiter = db.insertDecision({ title: 'Late', summary: 'Refs APP-123', sourceUrl: null, platform: 'git' });
    db.replaceRefs(lateCiter, [{ ref: 'APP-123', platform: 'tracker' }]);
    db.close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE decision_identities');
    raw.close();
    expect(rows()).toEqual([{ source: oldCiter, target: t, relation: 'relates', v: 'v0' }]);

    createLocalDb(path).close();

    expect(rows()).toEqual(
      [{ source: oldCiter, target: t, relation: 'relates', v: 'ref' }, { source: lateCiter, target: t, relation: 'relates', v: 'ref' }]
        .sort((a, b) => (a.source < b.source ? -1 : 1)),
    );
  });
});
