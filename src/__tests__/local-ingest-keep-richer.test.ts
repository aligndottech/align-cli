// L3 review 2 and 8. An items-first GitHub arrival (detail_pending) carries a THIN body: the
// discussion is missing. When the stored row already has its discussion, "keep the richer text"
// has to mean the whole row: no re-embed on the thin text, no cleared enriched_at, no re-link.
// What is NOT thin is the title, so a rename still applies (unless a person attested the text).
//
// Precisely: an items-first arrival is "not thinner" in its TITLE always (a title never carries
// discussion), and "thinner" in its BODY iff the stored summary starts with the incoming body.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const embedded: string[] = [];
vi.mock('../lib/local-embeddings.js', () => ({
  getEmbedding: vi.fn(async (t: string) => {
    embedded.push(t);
    return new Float32Array(384).fill(t.includes('Postgres') ? 0.9 : 0.1);
  }),
  cosineSimilarity: vi.fn().mockReturnValue(0.8),
  EMBEDDING_MODEL_ID: 'Xenova/all-MiniLM-L6-v2',
}));

import { createLocalDb } from '../lib/local-db.js';
import { createLocalGatewayClient } from '../lib/local-gateway-client.js';

vi.setConfig({ testTimeout: 30_000 });

const PR1 = 'https://github.com/o/r/pull/1';
const PR2 = 'https://github.com/o/r/pull/2';
const THIN = 'Body only';
const FULL = 'Body only\n\nComment: we chose Postgres';
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-richer-'));
  dbPath = path.join(dir, 'graph.db');
  embedded.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ing = (url: string, raw: string, pending: boolean, title: string) =>
  createLocalGatewayClient(dbPath).ingestBatch(
    [{ source_url: url, platform: 'github', title, raw_text: raw, detail_pending: pending }],
    { classify: false, keyed: true },
  );

interface Snap { title: string; summary: string; detail_pending: number; enriched_at: string | null; vec: number; links: number }
function snap(url: string): Snap {
  const db = new DatabaseSync(dbPath);
  try {
    const d = db.prepare('SELECT id, title, summary, detail_pending, enriched_at FROM decisions WHERE source_url = ?').get(url) as
      { id: string; title: string; summary: string; detail_pending: number; enriched_at: string | null };
    const e = db.prepare('SELECT * FROM decision_embeddings WHERE decision_id = ?').get(d.id) as Record<string, unknown>;
    const buf = Object.values(e).find((v) => v instanceof Uint8Array) as Uint8Array;
    const links = (db.prepare('SELECT COUNT(*) AS n FROM decision_links').get() as { n: number }).n;
    return { ...d, vec: new Float32Array(buf.buffer, buf.byteOffset, 1)[0]!, links };
  } finally { db.close(); }
}
async function seedFull(): Promise<Snap> {
  await ing(PR2, 'Another PR about Postgres', false, 'PR 2');
  await ing(PR1, FULL, false, 'PR 1');
  return snap(PR1);
}

describe('an items-first re-import of a row that already has its discussion', () => {
  it('leaves the embedding, enriched_at, links, text and flag exactly as they were, and never embeds the thin text', async () => {
    const before = await seedFull();
    expect(before.links).toBeGreaterThan(0); // the control: there are links to leave alone
    embedded.length = 0;
    await ing(PR1, THIN, true, 'PR 1');
    expect(snap(PR1)).toEqual(before);
    expect(embedded.filter((t) => !t.includes('Postgres'))).toEqual([]);
    expect(embedded).toEqual([]);
  });

  it('applies a RENAME: the title updates, the embedding is of the new title plus the STORED body, and the body and flag stay', async () => {
    await seedFull();
    embedded.length = 0;
    await ing(PR1, THIN, true, 'PR 1 renamed');
    const after = snap(PR1);
    expect(after).toMatchObject({ title: 'PR 1 renamed', summary: FULL, detail_pending: 0 });
    expect(embedded).toEqual([`PR 1 renamed. ${FULL}`]);
    expect(after.vec).toBeCloseTo(0.9); // the Postgres-bearing vector, not the thin 0.1 one
  });

  it('a second rename (two examples) lands the same way', async () => {
    await seedFull();
    await ing(PR1, THIN, true, 'First');
    await ing(PR1, THIN, true, 'Second');
    expect(snap(PR1)).toMatchObject({ title: 'Second', summary: FULL });
  });

  it('an EDITED body is not a prefix of the stored text, so it applies and the row is pending again', async () => {
    await seedFull();
    await ing(PR1, 'Body, edited upstream', true, 'PR 1');
    expect(snap(PR1)).toMatchObject({ summary: 'Body, edited upstream', detail_pending: 1 });
  });

  it('a row that is itself pending takes the new thin text (nothing richer to protect)', async () => {
    await ing(PR1, THIN, true, 'PR 1');
    await ing(PR1, 'Body edited', true, 'PR 1');
    expect(snap(PR1)).toMatchObject({ summary: 'Body edited', detail_pending: 1 });
  });
});

describe('an attested (ratified) row keeps its text whatever arrives', () => {
  function ratify(url: string): void {
    const db = new DatabaseSync(dbPath);
    db.prepare(`UPDATE decisions SET ratified_at = '2026-10-01T00:00:00.000Z', ratified_by = 'me' WHERE source_url = ?`).run(url);
    db.close();
  }

  it('a rename on an attested row is not applied, and nothing is re-embedded', async () => {
    const before = await seedFull();
    ratify(PR1);
    embedded.length = 0;
    await ing(PR1, THIN, true, 'PR 1 renamed');
    expect(snap(PR1)).toMatchObject({ title: before.title, summary: FULL, vec: before.vec });
    expect(embedded).toEqual([]);
  });

  it('review 8: a thin attested row stays pending when a full item arrives and the attested text is kept', () => {
    const db = createLocalDb(dbPath);
    try {
      const id = db.insertDecision({ title: 'PR 1', summary: THIN, sourceUrl: PR1, platform: 'github', keyed: true, detailPending: true });
      const raw = new DatabaseSync(dbPath);
      raw.prepare(`UPDATE decisions SET ratified_at = '2026-10-01T00:00:00.000Z' WHERE id = ?`).run(id);
      raw.close();
      db.insertDecision({ title: 'PR 1', summary: FULL, sourceUrl: PR1, platform: 'github', keyed: true, detailPending: false });
      expect(db.getDecisionById(id)).toMatchObject({ summary: THIN });
      const check = new DatabaseSync(dbPath);
      const row = check.prepare('SELECT detail_pending FROM decisions WHERE id = ?').get(id) as { detail_pending: number };
      check.close();
      expect(row.detail_pending).toBe(1);
    } finally { db.close(); }
  });
});
