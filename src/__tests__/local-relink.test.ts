// P3 + review F1/F2/F3/F5: `align local relink --detector v1`. Re-types existing v0 links with the
// v1 detector, explicitly. The set classifier is faked at its own boundary; every other write
// (the capture-time classifier edge, a person's `align mark ... replaces`) goes through the REAL
// writer, so the fixtures are the populations those writers leave behind.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyJudgement } from '../lib/curation/mark.js';
import { createLocalDb } from '../lib/local-db.js';
import { planRelink, relinkWithV1 } from '../lib/local-relink.js';
import type { SetCandidate, SetOutcome, SetSubject } from '../lib/local-set-classifier.js';

let dir: string;
let dbPath: string;
const me = { judgeId: 'me', judgeLabel: null };

function exec(sql: string): void { const x = new DatabaseSync(dbPath); try { x.exec(sql); } finally { x.close(); } }
const rows = () => {
  const x = new DatabaseSync(dbPath);
  try {
    return x.prepare('SELECT source_id, target_id, relation, confidence, detector_version FROM decision_links ORDER BY source_id, target_id, detector_version, relation').all();
  } finally { x.close(); }
};
const hash = () => createHash('sha256').update(JSON.stringify(rows())).digest('hex');
/** A capture-time v0 classifier edge, written the way linkPass writes it. */
function classifierEdge(sourceId: string, targetId: string, relation: string, confidence = 0.9): void {
  const db = createLocalDb(dbPath);
  try { db.replaceLink({ sourceId, targetId, relation, confidence }); } finally { db.close(); }
}

type Verdict = { relation: string | null; confidence: number };
function fake(byTarget: Record<string, Verdict>) {
  return vi.fn(async (_s: SetSubject, cands: readonly SetCandidate[]): Promise<SetOutcome> => ({
    ok: true, verdicts: cands.map((c) => byTarget[c.id] ?? { relation: null, confidence: 0 }),
  }));
}
const run = (classify: ReturnType<typeof fake>, opts: Partial<{ apply: boolean; replace: boolean; maxCalls: number }> = {}) =>
  relinkWithV1(dbPath, { apply: false, replace: false, maxCalls: 50, ...opts }, classify);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-relink-'));
  dbPath = path.join(dir, 'graph.db');
  createLocalDb(dbPath).close();
  exec(`INSERT INTO decisions (id, title, summary, decided_at) VALUES
    ('n', 'New', 'new text', '2026-02-01T00:00:00Z'), ('a', 'A', 'a text', '2026-01-01T00:00:00Z'),
    ('b', 'B', 'b text', NULL), ('c', 'C', 'c text', NULL)`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('F1: a person\'s judgement and an omitted verdict are never overwritten', () => {
  it('a mark written over an existing classifier supersedes row (mark.ts real sequence) is never touched, even with --replace', async () => {
    classifierEdge('n', 'a', 'supersedes', 0.9);
    applyJudgement({ dbPath, judge: me, origin: { via: 'cli' } }, { action: 'replaces', newer: 'n', older: 'a' });
    const before = hash();
    const classify = fake({ a: { relation: 'relates', confidence: 0.4 } });
    const r = await run(classify, { apply: true, replace: true });
    expect(hash()).toBe(before);
    expect(rows()).toContainEqual(expect.objectContaining({ source_id: 'n', target_id: 'a', relation: 'supersedes' }));
    expect(classify).not.toHaveBeenCalled();
    expect(r.skippedJudged).toBe(1);
  });

  it('a conflict verdict on the pair also keeps relink away', async () => {
    classifierEdge('n', 'b', 'conflicts_with');
    applyJudgement({ dbPath, judge: me, origin: { via: 'cli' } }, { action: 'conflict', a: 'b', b: 'n', verdict: 'false' });
    const classify = fake({ b: { relation: 'relates', confidence: 0.4 } });
    await run(classify, { apply: true, replace: true });
    expect(classify).not.toHaveBeenCalled();
    expect(rows()).toContainEqual(expect.objectContaining({ source_id: 'n', target_id: 'b', relation: 'conflicts_with', detector_version: 'v0' }));
  });

  it('positive control: the same classifier row with no judgement IS relinked', async () => {
    classifierEdge('n', 'a', 'supersedes', 0.9);
    const classify = fake({ a: { relation: 'refines', confidence: 0.4 } });
    await run(classify, { apply: true, replace: true });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([expect.objectContaining({ source_id: 'n', target_id: 'a', relation: 'refines', detector_version: 'v1' })]);
  });

  it('an omitted (null) verdict leaves a typed v0 row exactly as it is, with --replace', async () => {
    classifierEdge('n', 'a', 'supersedes', 0.9);
    const before = hash();
    const r = await run(fake({}), { apply: true, replace: true });
    expect(hash()).toBe(before);
    expect(r).toMatchObject({ omitted: 1, written: [] });
  });

  it('an omitted verdict leaves a relates v0 row as it is too, without --replace', async () => {
    classifierEdge('n', 'b', 'relates', 0.7);
    const before = hash();
    await run(fake({}), { apply: true });
    expect(hash()).toBe(before);
  });
});

describe('F2: one judgement per unordered pair', () => {
  it('links in both directions on one pair -> one call, the candidate once, and the report equals the graph', async () => {
    exec(`INSERT INTO decision_links (id, source_id, target_id, relation, confidence) VALUES
      ('x1', 'n', 'a', 'relates', 0.5), ('x2', 'n', 'a', 'conflicts_with', 0.8), ('x3', 'a', 'n', 'relates', 0.5)`);
    const classify = fake({ a: { relation: 'refines', confidence: 0.6 } });
    const r = await run(classify, { apply: true, replace: true });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]![1].map((c) => c.id)).toEqual(['a']);
    expect(r.written).toEqual([{ sourceId: 'n', targetId: 'a', from: ['conflicts_with', 'relates'], to: 'refines' }]);
    expect(rows()).toEqual([expect.objectContaining({ source_id: 'n', target_id: 'a', relation: 'refines', detector_version: 'v1' })]);
  });

  it('several pairs from one source share one call, each candidate once', async () => {
    classifierEdge('n', 'a', 'relates');
    classifierEdge('n', 'b', 'relates');
    const classify = fake({});
    await run(classify);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]![1].map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('a dry run writes nothing and lists proposals, never as written', async () => {
    classifierEdge('n', 'a', 'conflicts_with');
    const before = hash();
    const r = await run(fake({ a: { relation: 'refines', confidence: 0.6 } }));
    expect(hash()).toBe(before);
    expect(r.proposed).toEqual([{ sourceId: 'n', targetId: 'a', from: ['conflicts_with'], to: 'refines' }]);
    expect(r.written).toEqual([]);
  });

  it('without --replace a changed pair gains a v1 row beside the v0 row; an unchanged pair gains nothing', async () => {
    classifierEdge('n', 'a', 'conflicts_with');
    classifierEdge('n', 'b', 'relates', 0.7);
    const r = await run(fake({ a: { relation: 'refines', confidence: 0.6 }, b: { relation: 'relates', confidence: 0.6 } }), { apply: true });
    expect(r.written).toEqual([{ sourceId: 'n', targetId: 'a', from: ['conflicts_with'], to: 'refines' }]);
    expect(r.unchanged).toBe(1);
    expect(rows()).toEqual([
      expect.objectContaining({ source_id: 'n', target_id: 'a', relation: 'conflicts_with', detector_version: 'v0' }),
      expect.objectContaining({ source_id: 'n', target_id: 'a', relation: 'refines', detector_version: 'v1' }),
      expect.objectContaining({ source_id: 'n', target_id: 'b', relation: 'relates', detector_version: 'v0' }),
    ]);
  });

  it('a pair that already has a v1 row is not asked again', async () => {
    classifierEdge('n', 'a', 'conflicts_with');
    await run(fake({ a: { relation: 'refines', confidence: 0.6 } }), { apply: true });
    const classify = fake({});
    await run(classify, { apply: true });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('F3: the call cap and the plan', () => {
  it('planRelink counts calls and pairs without calling anything', () => {
    classifierEdge('n', 'a', 'relates');
    classifierEdge('n', 'b', 'relates');
    classifierEdge('c', 'a', 'relates');
    const plan = planRelink(dbPath);
    expect(plan).toMatchObject({ calls: 2, pairs: 3 });
    expect(plan.inputTokens).toBeGreaterThan(0);
    expect(plan.maxOutputTokens).toBe(2 * 2048);
  });

  it('maxCalls stops before the call that would exceed it, and says how many remain', async () => {
    classifierEdge('n', 'a', 'relates');
    classifierEdge('c', 'b', 'relates');
    const classify = fake({});
    const r = await run(classify, { maxCalls: 1 });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(r.remainingCalls).toBe(1);
  });

  it('a stopped provider asks nothing more', async () => {
    classifierEdge('n', 'a', 'relates');
    classifierEdge('c', 'b', 'relates');
    const stopped = vi.fn(async (): Promise<SetOutcome> => ({ ok: false, reason: 'classifier_error', failure: { kind: 'provider_stopped', provider: 'anthropic', model: 'm', detail: '429' } }));
    const r = await relinkWithV1(dbPath, { apply: true, replace: false, maxCalls: 50 }, stopped);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(r.stopped).toMatch(/anthropic/);
  });
});

describe('F5: relink tells the detector a candidate is retired', () => {
  it('a candidate superseded by a third decision is passed as superseded', async () => {
    classifierEdge('n', 'a', 'relates');
    classifierEdge('c', 'a', 'supersedes');
    const classify = fake({});
    await run(classify);
    const call = classify.mock.calls.find((c) => c[0].title === 'New')!;
    expect(call[1]).toEqual([expect.objectContaining({ id: 'a', status: 'superseded' })]);
  });

  it('a candidate nobody superseded is passed with no status', async () => {
    classifierEdge('n', 'b', 'relates');
    const classify = fake({});
    await run(classify);
    expect(classify.mock.calls[0]![1]).toEqual([expect.objectContaining({ id: 'b', status: null })]);
  });
});
