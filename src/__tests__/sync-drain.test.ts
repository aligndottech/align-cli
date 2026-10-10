import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Sdk = (items: FetcherItem[], o: { token: string; maxRequests: number }) => Promise<{ items: FetcherItem[]; skips: unknown[]; requests: number }>;
const sdk = vi.hoisted(() => ({ current: undefined as undefined | Sdk }));
// The SDK's drain function is the boundary. By default the REAL one runs (against a mocked network);
// a test that needs the SDK's cost model without 300 HTTP fixtures swaps in a fake with the same contract.
vi.mock('@aligndottech/connector-core', async (orig) => {
  const actual = await orig<{ fetchGitHubDiscussion: Sdk }>();
  return { ...actual, fetchGitHubDiscussion: (items: FetcherItem[], o: { token: string; maxRequests: number }) => (sdk.current ?? actual.fetchGitHubDiscussion)(items, o) };
});

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async (t: string) => { await new Promise<void>((r) => setImmediate(r)); const v = new Float32Array(384).fill(0.1); v[0] = t.includes('Postgres') ? 0.9 : 0.1; return v; }),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import type { FetcherItem } from '@aligndottech/connector-core';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { GITHUB_DISCUSSION_BUDGET } from '../lib/import-defaults.js';
import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { drainGitHub } from '../lib/sync/drain.js';
import { PR_URL, realShapes } from './helpers/github-real-shapes.js';
import { rmDir } from './helpers/rm-dir.js';

/**
 * L5 Test List (discussion drain, Decision 27):
 * - Given 300 GitHub rows with detail_pending, one run enriches them newest first and stops within GITHUB_DISCUSSION_BUDGET requests,
 *   clearing detail_pending only on the rows it enriched. Given 0 pending, no discussion requests.
 * - The enriched text is the stored header plus the SDK's own discussion (real shapes), re-embedded; the title does not change.
 * - A ratified (attested) row is read, its flag cleared, and its attested text kept.
 * - A drain that reads nothing (refused) changes nothing: rows stay pending.
 */
vi.setConfig({ testTimeout: 60_000 });
let dir: string;
let dbPath: string;
beforeEach(() => {
  sdk.current = undefined;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l5-drain-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => rmDir(dir));

function sql<T = Record<string, unknown>>(q: string, ...a: Array<string | number>): T[] {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(q).all(...a) as T[]; } finally { db.close(); }
}

// Seeds the pending rows straight into the graph. Going through ingestBatch would embed, link and refs-resolve each
// row in its own commit (about 54 ms a row on Linux, minutes on Windows' fsync) and this test is about the DRAIN, not about ingest.
async function seedPending(n: number): Promise<void> {
  const db = createLocalDb(dbPath);
  try {
    for (let i = 0; i < n; i++) {
      db.insertDecision({
        title: `PR ${i + 1}`, summary: `PR ${i + 1}\n\nbody ${i + 1}\n\nStatus: open\nRepo: o/r`, sourceUrl: PR_URL(i + 1), platform: 'github',
        // newer number = newer date, so "newest first" is highest number first
        decidedAt: new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString(), keyed: true, detailPending: true,
      });
    }
  } finally { db.close(); }
}

/** A fake SDK drain with the SDK's cost model (4 requests an item) and its stop rule (an item is started only when it fits). */
function fakeSdk(log: { asked: string[]; requests: number }): Sdk {
  return async (items, o) => {
    const out: FetcherItem[] = [];
    let used = 0;
    for (const it of items) {
      if (used + 4 > o.maxRequests) break;
      used += 4;
      log.asked.push(it.source_url);
      out.push({ ...it, raw_text: `${it.raw_text}\n\n## Comments\n[alice] we chose Postgres`, detail_pending: false });
    }
    log.requests += used;
    return { items: out, skips: [], requests: used };
  };
}

describe('drainGitHub', () => {
  it('300 pending rows: enriches newest first, stays within the request budget, and clears the flag only on the rows it enriched', async () => {
    await seedPending(300);
    const log = { asked: [] as string[], requests: 0 };
    sdk.current = fakeSdk(log);
    const c = createLocalGatewayClient(dbPath);
    // The L3 chunked drain runs for real, over the fake SDK function: its stop rules are part of what is under test.
    const r = await drainGitHub(dbPath, c, 't');
    c.close();
    expect(log.requests).toBeLessThanOrEqual(GITHUB_DISCUSSION_BUDGET);
    expect(r.enriched).toBe(GITHUB_DISCUSSION_BUDGET / 4);
    expect(r.remaining).toBe(300 - GITHUB_DISCUSSION_BUDGET / 4);
    // newest first: the first rows asked for are the highest-numbered PRs
    expect(log.asked.slice(0, 3)).toEqual([PR_URL(300), PR_URL(299), PR_URL(298)]);
    const cleared = sql<{ title: string }>(`SELECT title FROM decisions WHERE detail_pending = 0`).map((x) => x.title);
    expect(cleared).toHaveLength(150);
    expect(cleared).toContain('PR 300');
    expect(cleared).not.toContain('PR 150');
    expect(sql(`SELECT 1 FROM decisions WHERE detail_pending = 1`)).toHaveLength(150);
    expect(sql<{ summary: string }>(`SELECT summary FROM decisions WHERE title = 'PR 300'`)[0]!.summary).toContain('we chose Postgres');
    expect(r.skips.some((k) => k.kind === 'page_cap')).toBe(true); // and it says the budget ran out
  }, 600_000); // 150 real ingests, each several commits: about 5 s on Linux, and the Windows runner is an order slower

  it('a second run picks up where the first stopped (pending rows keep their place)', async () => {
    await seedPending(8);
    const log = { asked: [] as string[], requests: 0 };
    sdk.current = fakeSdk(log);
    const c = createLocalGatewayClient(dbPath);
    const first = await drainGitHub(dbPath, c, 't', { budget: 12 });
    const second = await drainGitHub(dbPath, c, 't', { budget: 12 });
    const third = await drainGitHub(dbPath, c, 't', { budget: 12 });
    c.close();
    expect([first.enriched, second.enriched, third.enriched]).toEqual([3, 3, 2]);
    expect(third.remaining).toBe(0);
    expect(sql(`SELECT 1 FROM decisions WHERE detail_pending = 1`)).toHaveLength(0);
  });

  it('0 pending rows: no discussion request is made at all', async () => {
    const c = createLocalGatewayClient(dbPath);
    const drain = vi.fn();
    const r = await drainGitHub(dbPath, c, 't', { drain });
    c.close();
    expect(drain).not.toHaveBeenCalled();
    expect(r).toEqual({ enriched: 0, remaining: 0, skips: [] });
  });

  it('real SDK text: the enriched row is the stored header plus the SDK\'s own discussion, same title, re-embedded', async () => {
    sdk.current = undefined;
    const { thin, full } = await realShapes({ title: 'Use Postgres', comments: [{ who: 'alice', text: 'we chose Postgres' }] });
    const c = createLocalGatewayClient(dbPath);
    await c.ingestBatch([{ source_url: thin.source_url, platform: 'github', title: thin.title, raw_text: thin.raw_text, created_at: thin.created_at, detail_pending: true }], { classify: false, keyed: true });
    expect(sql<{ detail_pending: number }>('SELECT detail_pending FROM decisions')[0]!.detail_pending).toBe(1);

    // The SDK's own drain over a mocked network, called the way the product calls it.
    const agent = new MockAgent();
    agent.disableNetConnect();
    const api = agent.get('https://api.github.com');
    const json = { headers: { 'content-type': 'application/json' } };
    api.intercept({ path: (p) => p.startsWith('/repos/o/r/issues/1/comments') }).reply(200, [{ user: { login: 'alice' }, created_at: '2026-09-02T01:00:00Z', body: 'we chose Postgres' }], json).persist();
    api.intercept({ path: (p) => p.startsWith('/repos/o/r/pulls/1/') }).reply(200, [], json).persist();
    setGlobalDispatcher(agent);
    try {
      const r = await drainGitHub(dbPath, c, 't');
      expect(r.enriched).toBe(1);
    } finally { await agent.close(); }
    c.close();
    const row = sql<{ title: string; summary: string; detail_pending: number }>('SELECT title, summary, detail_pending FROM decisions')[0]!;
    expect(row.summary).toBe(full.raw_text);
    expect(row).toMatchObject({ title: thin.title, detail_pending: 0 });
    expect(sql('SELECT 1 FROM decisions')).toHaveLength(1);
  });

  it('a ratified row: its discussion is read and its flag cleared, and the attested text stays', async () => {
    await seedPending(1);
    const ratifiedText = sql<{ summary: string }>('SELECT summary FROM decisions')[0]!.summary;
    const db = new DatabaseSync(dbPath); db.exec(`UPDATE decisions SET ratified_at = '2026-09-02', ratified_by = 'me'`); db.close();
    sdk.current = fakeSdk({ asked: [], requests: 0 });
    const c = createLocalGatewayClient(dbPath);
    const r = await drainGitHub(dbPath, c, 't');
    c.close();
    expect(r.enriched).toBe(1);
    const row = sql<{ summary: string; detail_pending: number }>('SELECT summary, detail_pending FROM decisions')[0]!;
    expect(row.summary).toBe(ratifiedText);
    expect(row.detail_pending).toBe(0);
  });

  it('a drain that read nothing (GitHub refused) changes nothing: every row stays pending, and the skips come back', async () => {
    await seedPending(3);
    const c = createLocalGatewayClient(dbPath);
    const before = sql('SELECT id, summary, enriched_at FROM decisions ORDER BY id');
    const r = await drainGitHub(dbPath, c, 't', { drain: async () => ({ items: [], skips: [{ kind: 'error', count: 3, detail: 'refused' }] }) });
    c.close();
    expect(r).toEqual({ enriched: 0, remaining: 3, skips: [{ kind: 'error', count: 3, detail: 'refused' }] });
    expect(sql('SELECT id, summary, enriched_at FROM decisions ORDER BY id')).toEqual(before);
    expect(sql('SELECT 1 FROM decisions WHERE detail_pending = 1')).toHaveLength(3);
  });
});
