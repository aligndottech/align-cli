// P3 / Phase B prerequisite: load a frozen JSON snapshot (decisions with their ids and decided_at,
// optionally their links) into a THROWAWAY local graph. Never the user's real graph: the loader
// refuses an existing file and the default local.db path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSnapshot, type Snapshot } from '../lib/local-snapshot-loader.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-snapshot-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const snap = (): Snapshot => ({
  snapshot: 'fixture',
  decisions: [
    { id: 'id-a', title: 'Use Postgres', summary: 'Jobs in Postgres.', source_url: 'https://github.com/o/r/pull/1', platform: 'github', decided_at: '2026-01-01T00:00:00Z' },
    { id: 'id-b', title: 'Use SQS', summary: 'Jobs in SQS.', source_url: null, platform: 'slack', decided_at: null },
  ],
  links: [{ source_id: 'id-b', target_id: 'id-a', relation: 'conflicts_with', confidence: 0.8 }],
});
const q = (db: string, sql: string) => { const x = new DatabaseSync(db); try { return x.prepare(sql).all(); } finally { x.close(); } };

describe('loadSnapshot', () => {
  it('keeps ids, decided_at and platform exactly; links only when asked', () => {
    const db = path.join(dir, 'a.db');
    expect(loadSnapshot(snap(), db, { links: false })).toEqual({ decisions: 2, links: 0 });
    expect(q(db, 'SELECT id, decided_at, platform FROM decisions ORDER BY id')).toEqual([
      { id: 'id-a', decided_at: '2026-01-01T00:00:00Z', platform: 'github' },
      { id: 'id-b', decided_at: null, platform: 'slack' },
    ]);
    expect(q(db, 'SELECT COUNT(*) AS n FROM decision_links')).toEqual([{ n: 0 }]);
  });

  it('with links: imports them stamped detector_version snapshot, so relink never touches them', () => {
    const db = path.join(dir, 'b.db');
    expect(loadSnapshot(snap(), db, { links: true })).toEqual({ decisions: 2, links: 1 });
    expect(q(db, 'SELECT source_id, target_id, relation, confidence, detector_version FROM decision_links')).toEqual([
      { source_id: 'id-b', target_id: 'id-a', relation: 'conflicts_with', confidence: 0.8, detector_version: 'snapshot' },
    ]);
  });

  it('refuses a file that already exists, and changes nothing in it', () => {
    const db = path.join(dir, 'exists.db');
    fs.writeFileSync(db, 'precious');
    expect(() => loadSnapshot(snap(), db, { links: true })).toThrow(/already exists/);
    expect(fs.readFileSync(db, 'utf8')).toBe('precious');
  });

  it('refuses the real local graph path even when it does not exist yet', () => {
    expect(() => loadSnapshot(snap(), path.join(dir, 'x.db'), { links: false, realDbPath: path.join(dir, 'x.db') })).toThrow(/real local graph/);
  });

  it('refuses a link naming an id the snapshot does not hold, before writing any file', () => {
    const bad = snap();
    bad.links!.push({ source_id: 'id-b', target_id: 'missing', relation: 'relates', confidence: 1 });
    const db = path.join(dir, 'c.db');
    expect(() => loadSnapshot(bad, db, { links: true })).toThrow(/missing/);
    expect(fs.existsSync(db)).toBe(false);
  });

  it('refuses a relation outside the contract vocabulary, and a duplicate id', () => {
    const badRel = snap();
    badRel.links![0]!.relation = 'unrelated';
    expect(() => loadSnapshot(badRel, path.join(dir, 'd.db'), { links: true })).toThrow(/unrelated/);
    const dup = snap();
    dup.decisions.push({ ...dup.decisions[0]! });
    expect(() => loadSnapshot(dup, path.join(dir, 'e.db'), { links: false })).toThrow(/duplicate id "id-a"/);
  });

  it('refuses an empty snapshot rather than writing an empty graph', () => {
    expect(() => loadSnapshot({ snapshot: 'x', decisions: [] }, path.join(dir, 'f.db'), { links: false })).toThrow(/no decisions/);
  });
});
