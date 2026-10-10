// L3: a GitHub item fetched items-first (discussion: 'none') arrives with detail_pending, and the
// local graph has to remember that, or the discussion drain has nothing to find.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.1),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';
import { rmDir } from './helpers/rm-dir.js';

vi.setConfig({ testTimeout: 30_000 });

const PR1 = 'https://github.com/o/r/pull/1';
const PR2 = 'https://github.com/o/r/pull/2';
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-pending-'));
  dbPath = path.join(dir, 'graph.db');
});
afterEach(() => rmDir(dir));

function row(url: string): { detail_pending: number; summary: string } {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare('SELECT detail_pending, summary FROM decisions WHERE source_url = ?').get(url) as never; } finally { db.close(); }
}
const item = (url: string, text: string, pending?: boolean) => ({
  source_url: url, platform: 'github', title: `PR ${url.slice(-1)}`, raw_text: text, ...(pending === undefined ? {} : { detail_pending: pending }),
});
// Close the client: Windows refuses to delete a graph.db a handle still holds open.
const ingest = async (items: ReturnType<typeof item>[]) => {
  const c = createLocalGatewayClient(dbPath);
  try { return await c.ingestBatch(items, { classify: false, keyed: true }); } finally { c.close(); }
};

describe('detail_pending is stored from the fetched item', () => {
  it('an items-first item is stored pending', async () => {
    await ingest([item(PR1, 'Body only', true)]);
    expect(row(PR1).detail_pending).toBe(1);
  });

  it('a whole item, or one that says nothing, is stored not pending (two examples)', async () => {
    await ingest([item(PR1, 'Body and discussion', false), item(PR2, 'Body and discussion')]);
    expect(row(PR1).detail_pending).toBe(0);
    expect(row(PR2).detail_pending).toBe(0);
  });

  it('the whole item arriving later clears the flag and takes its text', async () => {
    await ingest([item(PR1, 'Body only', true)]);
    await ingest([item(PR1, 'Body only\n\nComment: we chose Postgres', false)]);
    expect(row(PR1)).toMatchObject({ detail_pending: 0, summary: expect.stringContaining('we chose Postgres') });
  });
});

// The re-import-over-a-complete-row cases live in local-ingest-keep-richer.test.ts, on the SDK's real text.
