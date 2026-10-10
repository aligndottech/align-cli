// P3: `align local relink --detector v1`. Re-types existing v0 links with the v1 detector,
// explicitly. Dry run (the default) writes nothing; --apply adds v1 rows beside the v0 ones;
// --apply --replace swaps them. The set classifier is faked at its own boundary.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalDb } from '../lib/local-db.js';
import { relinkWithV1 } from '../lib/local-relink.js';
import type { SetOutcome } from '../lib/local-set-classifier.js';

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-relink-'));
  dbPath = path.join(dir, 'graph.db');
  const db = createLocalDb(dbPath);
  db.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec(`INSERT INTO decisions (id, title, summary, decided_at) VALUES
    ('n', 'New', 'new text', '2026-02-01T00:00:00Z'), ('a', 'A', 'a text', '2026-01-01T00:00:00Z'), ('b', 'B', 'b text', NULL), ('m', 'M', 'm text', NULL)`);
  raw.exec(`INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES
    ('l1', 'n', 'a', 'conflicts_with', 0.9), ('l2', 'n', 'b', 'relates', 0.7), ('mark:j1', 'm', 'a', 'supersedes', 1.0)`);
  raw.close();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const rows = () => {
  const x = new DatabaseSync(dbPath);
  try { return x.prepare('SELECT id, source_id, target_id, relation, confidence, detector_version FROM decision_links ORDER BY source_id, target_id, detector_version, relation').all(); } finally { x.close(); }
};
const hash = () => createHash('sha256').update(JSON.stringify(rows())).digest('hex');

// a: v1 says refines (changed from conflicts_with); b: v1 omits it (no relationship -> relates, unchanged).
const answer = vi.fn(async (_s: unknown, cands: readonly { id: string }[]): Promise<SetOutcome> => ({
  ok: true, verdicts: cands.map((c) => (c.id === 'a' ? { relation: 'refines', confidence: 0.8 } : { relation: null, confidence: 0.7 })),
}));

describe('relinkWithV1', () => {
  it('dry run (the default) reports the change and writes nothing', async () => {
    const before = hash();
    const r = await relinkWithV1(dbPath, { apply: false, replace: false }, answer);
    expect(hash()).toBe(before);
    expect(rows()).toHaveLength(3);
    expect(r.changes).toEqual([{ sourceId: 'n', targetId: 'a', from: 'conflicts_with', to: 'refines' }]);
    expect(r).toMatchObject({ sources: 1, calls: 1, unchanged: 1, written: 0 });
  });

  it('one call per source decision, never per link, and a person\'s mark link is never re-typed', async () => {
    answer.mockClear();
    await relinkWithV1(dbPath, { apply: false, replace: false }, answer);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0]![0]).toMatchObject({ title: 'New', decidedAt: '2026-02-01T00:00:00Z' });
    expect(answer.mock.calls[0]![1].map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('--apply adds a v1 row beside the v0 row and keeps every v0 row', async () => {
    const r = await relinkWithV1(dbPath, { apply: true, replace: false }, answer);
    expect(r.written).toBe(1);
    expect(rows()).toEqual([
      { id: 'mark:j1', source_id: 'm', target_id: 'a', relation: 'supersedes', confidence: 1, detector_version: 'v0' },
      { id: 'l1', source_id: 'n', target_id: 'a', relation: 'conflicts_with', confidence: 0.9, detector_version: 'v0' },
      expect.objectContaining({ source_id: 'n', target_id: 'a', relation: 'refines', confidence: 0.8, detector_version: 'v1' }),
      { id: 'l2', source_id: 'n', target_id: 'b', relation: 'relates', confidence: 0.7, detector_version: 'v0' },
    ]);
  });

  it('a second --apply does not re-classify pairs that already have a v1 row', async () => {
    await relinkWithV1(dbPath, { apply: true, replace: false }, answer);
    answer.mockClear();
    const r = await relinkWithV1(dbPath, { apply: true, replace: false }, answer);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0]![1].map((c) => c.id)).toEqual(['b']);
    expect(r.written).toBe(0);
  });

  it('--apply --replace swaps each re-classified v0 row for a v1 row, unchanged ones included', async () => {
    await relinkWithV1(dbPath, { apply: true, replace: true }, answer);
    expect(rows()).toEqual([
      { id: 'mark:j1', source_id: 'm', target_id: 'a', relation: 'supersedes', confidence: 1, detector_version: 'v0' },
      expect.objectContaining({ source_id: 'n', target_id: 'a', relation: 'refines', detector_version: 'v1' }),
      expect.objectContaining({ source_id: 'n', target_id: 'b', relation: 'relates', confidence: 0.7, detector_version: 'v1' }),
    ]);
  });

  it('a failed call writes nothing for that source and is reported; a stopped provider stops the run', async () => {
    const stopped = vi.fn(async (): Promise<SetOutcome> => ({ ok: false, reason: 'classifier_error', failure: { kind: 'provider_stopped', provider: 'anthropic', model: 'm', detail: '429' } }));
    const before = hash();
    const r = await relinkWithV1(dbPath, { apply: true, replace: true }, stopped);
    expect(hash()).toBe(before);
    expect(r.failed).toBe(1);
    expect(r.stopped).toMatch(/anthropic/);
  });

  it('a v0 typed link that v1 gives no relationship becomes relates (a change), at its old confidence', async () => {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`UPDATE decision_links SET relation = 'contradicts' WHERE id = 'l2'`);
    raw.close();
    const r = await relinkWithV1(dbPath, { apply: true, replace: true }, answer);
    expect(r.changes).toContainEqual({ sourceId: 'n', targetId: 'b', from: 'contradicts', to: 'relates' });
    expect(rows()).toContainEqual(expect.objectContaining({ source_id: 'n', target_id: 'b', relation: 'relates', confidence: 0.7, detector_version: 'v1' }));
  });

  it('a stopped provider asks nothing more: the next source is not called', async () => {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES ('l3', 'b', 'a', 'relates', 0.6)`);
    raw.close();
    const stopped = vi.fn(async (): Promise<SetOutcome> => ({ ok: false, reason: 'classifier_error', failure: { kind: 'provider_stopped', provider: 'anthropic', model: 'm', detail: '429' } }));
    await relinkWithV1(dbPath, { apply: true, replace: false }, stopped);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('--limit caps the source decisions classified', async () => {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES ('l3', 'b', 'a', 'relates', 0.6)`);
    raw.close();
    answer.mockClear();
    const r = await relinkWithV1(dbPath, { apply: false, replace: false, limit: 1 }, answer);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(r.sources).toBe(1);
    expect(r.remainingSources).toBe(1);
  });
});
