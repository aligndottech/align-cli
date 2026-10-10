import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';

const llm = vi.hoisted(() => ({ configured: true, preferred: undefined as string | undefined }));
vi.mock('../lib/local-llm.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hasConfiguredProvider: () => llm.configured,
  preferredProvider: () => llm.preferred,
}));

import { classifyUnclassified, estimateClassify, unclassifiedItems } from '../lib/sync/classify.js';

/**
 * L5 Test List (--classify, Decision 1; the ONLY path that types imported items):
 * - Given 40 unclassified items, the estimate is "up to 120 calls" (min(N, unclassified) x 3) and no call is made by estimating.
 * - Given --max 10 with 40 available, 10 items, 30 calls; newest first. Given no provider, the estimate says so.
 * - Typed edges replace the free `relates` edge through the existing writer; an item is attempted once (a `relates` verdict is not "never asked").
 * - A stopped provider ends the run and leaves the unfinished item eligible.
 */
vi.setConfig({ testTimeout: 60_000 });
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-classify-'));
  dbPath = path.join(dir, 'graph.db');
  llm.configured = true;
  llm.preferred = undefined;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** n items, each with `perItem` high-confidence relates edges to a shared pool of older targets. */
function seed(n: number, perItem = 3): void {
  const db = createLocalDb(dbPath);
  const targets = Array.from({ length: perItem }, (_, k) => db.insertDecision({ title: `old ${k}`, summary: `old summary ${k}`, sourceUrl: `https://github.com/o/r/pull/${1000 + k}`, platform: 'github' }));
  for (let i = 0; i < n; i++) {
    const id = db.insertDecision({ title: `item ${i}`, summary: `summary ${i}`, sourceUrl: `https://github.com/o/r/pull/${i + 1}`, platform: 'github' });
    for (const t of targets) db.insertLink({ sourceId: id, targetId: t, relation: 'relates', confidence: 0.9 });
  }
  db.close();
}
function sql<T = Record<string, unknown>>(q: string): T[] {
  const x = new DatabaseSync(dbPath);
  try { return x.prepare(q).all() as T[]; } finally { x.close(); }
}
const ok = (type: string) => async () => ({ ok: true as const, relationship: { type: type as never, confidence: 0.8 } });

describe('estimateClassify', () => {
  it('40 unclassified items: up to 120 calls, and estimating calls nothing', () => {
    seed(40);
    llm.preferred = 'anthropic';
    const e = estimateClassify(dbPath, 40);
    expect(e).toMatchObject({ items: 40, calls: 120, available: 40, provider: 'Anthropic' });
  });

  it('--max 10 with 40 available: 10 items, up to 30 calls (second example)', () => {
    seed(40);
    expect(estimateClassify(dbPath, 10)).toMatchObject({ items: 10, calls: 30, available: 40 });
  });

  it('fewer unclassified than --max: the estimate is the real number', () => {
    seed(4);
    expect(estimateClassify(dbPath, 50)).toMatchObject({ items: 4, calls: 12 });
  });

  it('no provider configured: the estimate carries no provider so the caller can name `align ai`', () => {
    seed(3);
    llm.configured = false;
    expect(estimateClassify(dbPath, 3).provider).toBeUndefined();
  });

  it('items with a typed edge, or with only a weak relates edge, are not unclassified', () => {
    seed(2);
    const db = createLocalDb(dbPath);
    const ids = db.listDecisions().filter((d) => d.title.startsWith('item'));
    db.replaceLink({ sourceId: ids[0]!.id, targetId: db.listDecisions().find((d) => d.title === 'old 0')!.id, relation: 'supersedes', confidence: 0.8 });
    const weak = db.insertDecision({ title: 'weak', summary: 'w', sourceUrl: 'https://github.com/o/r/pull/99', platform: 'github' });
    db.insertLink({ sourceId: weak, targetId: ids[1]!.id, relation: 'relates', confidence: 0.4 });
    db.close();
    expect(unclassifiedItems(dbPath, 100).map((u) => u.title)).toEqual(['item 1']);
  });
});

describe('classifyUnclassified', () => {
  it('classifies at most --max items, newest first, with one call per candidate (max 3 per item)', async () => {
    seed(5);
    const seen: string[] = [];
    const classify = vi.fn(async (_a: { title: string }, b: { title: string }) => { seen.push(b.title); return ok('supersedes')(); });
    const r = await classifyUnclassified(dbPath, 2, classify);
    expect(r).toMatchObject({ items: 2, calls: 6, typed: 6 });
    expect(new Set(seen)).toEqual(new Set(['item 4', 'item 3']));
  });

  it('at most 3 candidates per item are classified, however many close matches it has (the capture-time budget)', async () => {
    seed(2, 5);
    const classify = vi.fn(ok('supersedes'));
    const r = await classifyUnclassified(dbPath, 10, classify);
    expect(r).toMatchObject({ items: 2, calls: 6 });
    expect(classify).toHaveBeenCalledTimes(6);
  });

  it('the strongest candidates are the ones asked about', async () => {
    const db = createLocalDb(dbPath);
    const item = db.insertDecision({ title: 'item', summary: 's', sourceUrl: 'https://github.com/o/r/pull/1', platform: 'github' });
    [0.66, 0.99, 0.8, 0.7].forEach((conf, k) => {
      const t = db.insertDecision({ title: `old ${k}`, summary: 'o', sourceUrl: `https://github.com/o/r/pull/${100 + k}`, platform: 'github' });
      db.insertLink({ sourceId: item, targetId: t, relation: 'relates', confidence: conf });
    });
    db.close();
    const asked: string[] = [];
    await classifyUnclassified(dbPath, 1, async (a) => { asked.push(a.title); return ok('relates')(); });
    expect(asked).toEqual(['old 1', 'old 2', 'old 3']);
  });

  it('writes the typed edge through the existing writer: the pair keeps ONE edge, now typed', async () => {
    seed(1, 1);
    await classifyUnclassified(dbPath, 1, ok('conflicts_with'));
    expect(sql<{ relation: string }>('SELECT relation FROM decision_links')).toEqual([{ relation: 'conflicts_with' }]);
  });

  it('an item is attempted once: a `relates` verdict does not make it eligible again', async () => {
    seed(2, 1);
    const classify = vi.fn(ok('relates'));
    await classifyUnclassified(dbPath, 10, classify);
    const again = await classifyUnclassified(dbPath, 10, classify);
    expect(again.items).toBe(0);
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('a stopped provider ends the run and leaves the item eligible; an unparseable answer is counted and the item is done', async () => {
    seed(2, 1);
    const stopped = await classifyUnclassified(dbPath, 10, async () => ({ ok: false as const, reason: 'classifier_error' as const, failure: { kind: 'provider_stopped' } as never }));
    expect(stopped.stopped).toMatch(/stopped answering/);
    expect(stopped.items).toBe(0);
    expect(unclassifiedItems(dbPath, 10)).toHaveLength(2);
    const bad = await classifyUnclassified(dbPath, 10, async () => ({ ok: false as const, reason: 'classifier_unparseable' as const }));
    expect(bad).toMatchObject({ items: 2, typed: 0, unparsed: 2 });
  });
});
