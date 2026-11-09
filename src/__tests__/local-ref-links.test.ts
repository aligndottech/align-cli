import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refIdentityFor } from '../lib/decision-refs.js';
import { deleteDecisionWithDependents } from '../lib/local-db-migrate.js';
import { foldKeylessTwin } from '../lib/local-db-v7.js';
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

const platformOf = (url: string): string => (url.includes('linear.app') ? 'linear' : url.includes('atlassian.net') ? 'jira' : 'github');

function ticket(db: ReturnType<typeof createLocalDb>, url = LINEAR, repo: string | null = null): string {
  const id = db.insertDecision({ title: 'APP-123', summary: 'Retry the queue', sourceUrl: url, platform: platformOf(url), repo });
  db.resolveRefs(id, refIdentityFor(platformOf(url), url), []);
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

  it('upgrades a guessed link to certain when the citing item arrives second', () => {
    const db = createLocalDb(path);
    const t = ticket(db);
    const c = db.insertDecision({ title: 'Retry three times', summary: 'Fixes it', sourceUrl: null, platform: 'git' });
    db.insertLink({ sourceId: c, targetId: t, relation: 'relates', confidence: 0.5 });
    db.replaceRefs(c, [{ ref: 'APP-123', platform: 'tracker' }]);
    db.resolveRefs(c, [], [{ ref: 'APP-123', platform: 'tracker' }]);
    db.close();
    expect(rows()).toEqual([{ source: c, target: t, relation: 'relates', v: 'ref' }]);
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
    ['the same repo: certain', 'o/a', 'o/a', ['ref']],
    ['an unknown repo on one side: linked, but not certain', null, 'o/a', ['v0']],
    ['two different repos: not linked', 'o/b', 'o/a', []],
  ])('%s', (_name, commitRepo, prRepo, stamps) => {
    const db = createLocalDb(path);
    ticket(db, PR, prRepo);
    commit(db, [{ ref: '#12', platform: 'code' }], commitRepo);
    db.close();
    expect(rows().map((r) => r.v)).toEqual(stamps);
  });

  it('two repos that each have a #12: a commit in one links only to its own, and is certain', () => {
    const db = createLocalDb(path);
    const mine = ticket(db, 'https://github.com/o/a/pull/12', 'o/a');
    ticket(db, 'https://github.com/o/b/pull/12', 'o/b');
    const c = commit(db, [{ ref: '#12', platform: 'code' }], 'o/a');
    db.close();
    expect(rows()).toEqual([{ source: c, target: mine, relation: 'relates', v: 'ref' }]);
  });
});

describe('one unit', () => {
  it('a failure part-way leaves the identities as they were', () => {
    const db = createLocalDb(path);
    const t = ticket(db);
    db.close();
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER fail_link BEFORE INSERT ON decision_links BEGIN SELECT RAISE(ABORT, 'boom'); END");
    raw.close();
    const again = createLocalDb(path);
    const c = again.insertDecision({ title: 'cites', summary: 's', sourceUrl: null, platform: 'git' });
    again.replaceRefs(c, [{ ref: 'APP-123', platform: 'tracker' }]);
    expect(() => again.resolveRefs(t, refIdentityFor('linear', LINEAR), [])).toThrow(/boom/);
    again.close();
    const check = new DatabaseSync(path);
    const ids = check.prepare('SELECT COUNT(*) AS n FROM decision_identities WHERE decision_id = ?').get(t) as { n: number };
    check.close();
    expect(ids.n).toBeGreaterThan(0);
  });
});

describe('an ambiguous reference is linked but never stamped certain', () => {
  it('a bare key that both a Jira issue and a Linear issue carry links to both, as guesses a model may re-type', () => {
    const db = createLocalDb(path);
    const linear = ticket(db);
    const jira = ticket(db, 'https://acme.atlassian.net/browse/APP-123');
    commit(db, [{ ref: 'APP-123', platform: 'tracker' }]);
    db.close();
    const all = rows();
    expect(all.map((r) => r.target).sort()).toEqual([jira, linear].sort());
    expect(all.every((r) => r.v === 'v0')).toBe(true);
  });
});

describe('a certain link outlives no reference', () => {
  it('a commit re-imported without the reference loses its certain link', () => {
    const db = createLocalDb(path);
    ticket(db);
    const c = commit(db, [{ ref: 'APP-123', platform: 'tracker' }]);
    db.replaceRefs(c, []);
    db.resolveRefs(c, [], []);
    db.close();
    expect(rows()).toEqual([]);
  });

  it('a call that does not pass the decision\'s own refs leaves its links alone', () => {
    const db = createLocalDb(path);
    const t = ticket(db);
    const c = commit(db, [{ ref: 'APP-123', platform: 'tracker' }]);
    db.resolveRefs(c, []);
    db.close();
    expect(rows()).toEqual([{ source: c, target: t, relation: 'relates', v: 'ref' }]);
  });
});

describe('merging two copies of one item', () => {
  it('keeps the certain stamp and what the merged copy could be cited as', () => {
    const db = createLocalDb(path);
    const keeper = db.insertDecision({ title: 'APP-123', summary: 'Retry the queue', sourceUrl: null, platform: 'linear' });
    const twin = ticket(db); // carries the identity; linked from a citer below
    const c = commit(db, [{ ref: 'APP-123', platform: 'tracker' }]);
    db.insertLink({ sourceId: c, targetId: keeper, relation: 'relates', confidence: 0.5 }); // a guess on the pair the merge lands on
    db.close();
    expect(rows().find((r) => r.target === twin)?.v).toBe('ref');

    const raw = new DatabaseSync(path);
    foldKeylessTwin(raw, twin, keeper, 'linear:APP-123');
    const identities = raw.prepare('SELECT decision_id AS id FROM decision_identities').all() as Array<{ id: string }>;
    raw.close();

    expect(rows()).toEqual([{ source: c, target: keeper, relation: 'relates', v: 'ref' }]);
    expect(identities.length).toBeGreaterThan(0);
    expect(identities.every((i) => i.id === keeper)).toBe(true);
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
