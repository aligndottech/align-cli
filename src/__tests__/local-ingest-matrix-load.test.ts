// LB: stored embeddings are read from SQLite once per ingest run, not once per item.
import type * as Embeddings from '../lib/local-embeddings.js';
import type * as LocalDb from '../lib/local-db.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../lib/local-embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Embeddings>()),
  getEmbedding: vi.fn(async (text: string) => Float32Array.from({ length: 8 }, (_, i) => Math.sin(text.length * (i + 1)))),
}));

const spies: Array<ReturnType<typeof vi.fn>> = [];
vi.mock('../lib/local-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalDb>();
  return {
    ...actual,
    createLocalDb: (...args: Parameters<typeof actual.createLocalDb>) => {
      const db = actual.createLocalDb(...args);
      const real = db.getAllEmbeddings.bind(db);
      const spy = vi.fn(real);
      db.getAllEmbeddings = spy as typeof db.getAllEmbeddings;
      spies.push(spy);
      return db;
    },
  };
});

import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

describe('ingestBatch reads stored embeddings once', () => {
  let dbPath: string;
  beforeEach(() => {
    spies.length = 0;
    dbPath = path.join(os.tmpdir(), `align-lb-load-${process.pid}-${Math.trunc(performance.now() * 1000)}.db`);
  });
  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  });

  const items = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({
    platform: 'github', source_url: `https://x.test/${tag}/${i}`, title: `${tag} ${i}`, raw_text: `${tag} body number ${i} ${'y'.repeat(i)}`,
  }));

  it('once for 50 items into an empty graph, and again once for a second run over the 50 it now holds', async () => {
    const client = createLocalGatewayClient(dbPath);
    await client.ingestBatch(items(50, 'first'), { classify: false, keyed: true });
    expect(spies[0]).toHaveBeenCalledTimes(1);
    spies[0]!.mockClear();
    await client.ingestBatch(items(50, 'second'), { classify: false, keyed: true });
    expect(spies[0]).toHaveBeenCalledTimes(1);
    client.close();
  });
});
