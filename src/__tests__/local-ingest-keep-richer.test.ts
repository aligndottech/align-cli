// L3 review 2 and 8. An items-first GitHub arrival (detail_pending) carries a THIN body: the
// discussion is missing. When the stored row already has its discussion, "keep the richer text"
// has to mean the whole row: no re-embed on the thin text, no cleared enriched_at, no re-link.
// What is NOT thin is the title, so a rename still applies (unless a person attested the text).
//
// Real text: every fixture comes from the SDK's own GitHub fetcher (helpers/github-real-shapes.ts),
// because the Status and Repo lines and the title sit INSIDE raw_text, so a text-prefix comparison
// fails on the first state change. The rule is structural: header + discussion block (the block
// starts at the first "## Comments|Code Reviews|Review Comments" heading that follows the Status line).

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
import type { FetcherItem } from '@aligndottech/connector-core';
import { PR_URL, type PrState, realShapes } from './helpers/github-real-shapes.js';

vi.setConfig({ testTimeout: 30_000 });

const PR1 = PR_URL(1);
let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-l3-richer-'));
  dbPath = path.join(dir, 'graph.db');
  embedded.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ingItem = (item: FetcherItem) =>
  createLocalGatewayClient(dbPath).ingestBatch(
    [{ source_url: item.source_url, platform: 'github', title: item.title, raw_text: item.raw_text, detail_pending: item.detail_pending === true }],
    { classify: false, keyed: true },
  );
const COMMENT = { who: 'alice', text: 'we chose Postgres' };

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
/** Store the COMPLETE version (header + discussion) of PR 1, after another PR so there are links. */
async function seedFull(state: PrState = { title: 'PR 1', comments: [COMMENT] }): Promise<{ stored: Snap; full: FetcherItem }> {
  await ingItem((await realShapes({ number: 2, title: 'PR 2', body: 'Another PR about Postgres', comments: [COMMENT] })).full);
  const { full } = await realShapes(state);
  await ingItem(full);
  return { stored: snap(PR1), full };
}
const discussionOf = (text: string): string => text.slice(text.indexOf('\n\n## Comments'));

describe('an items-first re-import of a row that already has its discussion (real GitHub text)', () => {
  it('the SDK really puts the title, Status and Repo lines inside raw_text (the premise of every case below)', async () => {
    const { thin, full } = await realShapes({ title: 'PR 1', comments: [COMMENT] });
    expect(thin.raw_text).toMatch(/^PR 1\n\n.*\n\nStatus: open\nRepo: o\/r$/s);
    expect(full.raw_text.startsWith(thin.raw_text)).toBe(true);
    expect(full.raw_text).toContain('\n\n## Comments\n[alice]');
  });

  it('UNCHANGED: leaves the embedding, enriched_at, links, text and flag exactly as they were, and embeds nothing', async () => {
    const { stored } = await seedFull();
    expect(stored.links).toBeGreaterThan(0); // the control: there are links to leave alone
    embedded.length = 0;
    await ingItem((await realShapes({ title: 'PR 1', comments: [COMMENT] })).thin);
    expect(snap(PR1)).toEqual(stored);
    expect(embedded).toEqual([]);
  });

  it('OPEN -> MERGED: the new Status lands, the old discussion stays, the flag stays 0, and it is re-embedded WITH the discussion', async () => {
    const { stored, full } = await seedFull();
    embedded.length = 0;
    await ingItem((await realShapes({ title: 'PR 1', state: 'closed', merged: true, comments: [] })).thin);
    const after = snap(PR1);
    expect(after.summary).toContain('Status: merged');
    expect(after.summary).not.toContain('Status: open');
    expect(discussionOf(after.summary)).toBe(discussionOf(full.raw_text));
    expect(after.detail_pending).toBe(0);
    expect(embedded).toEqual([`PR 1. ${after.summary}`]);
    expect(embedded[0]).toContain('we chose Postgres');
    expect(after.vec).toBeCloseTo(0.9); // the Postgres-bearing vector, not a thin one
    expect(stored.vec).toBeCloseTo(0.9);
  });

  it('RENAME: the new title applies, the discussion stays, the flag stays 0 (two renames, two examples)', async () => {
    const { full } = await seedFull();
    await ingItem((await realShapes({ title: 'PR 1 renamed', comments: [] })).thin);
    expect(snap(PR1)).toMatchObject({ title: 'PR 1 renamed', detail_pending: 0 });
    expect(snap(PR1).summary.startsWith('PR 1 renamed\n\n')).toBe(true);
    expect(discussionOf(snap(PR1).summary)).toBe(discussionOf(full.raw_text));
    await ingItem((await realShapes({ title: 'Second name', comments: [] })).thin);
    expect(snap(PR1)).toMatchObject({ title: 'Second name', detail_pending: 0 });
    expect(discussionOf(snap(PR1).summary)).toBe(discussionOf(full.raw_text));
  });

  it('an EDITED body applies with the old discussion kept', async () => {
    const { full } = await seedFull();
    await ingItem((await realShapes({ title: 'PR 1', body: 'Use a queue, edited upstream', comments: [] })).thin);
    const after = snap(PR1);
    expect(after.summary).toContain('Use a queue, edited upstream');
    expect(discussionOf(after.summary)).toBe(discussionOf(full.raw_text));
    expect(after.detail_pending).toBe(0);
  });

  it('a body that itself contains a "## Comments" heading is not mistaken for the discussion', async () => {
    const body = 'Plan\n\n## Comments\nnot a discussion, part of the body';
    const { full } = await seedFull({ title: 'PR 1', body, comments: [COMMENT] });
    await ingItem((await realShapes({ title: 'PR 1', body, state: 'closed', merged: true, comments: [] })).thin);
    const after = snap(PR1);
    expect(after.summary).toContain(body);
    expect(after.summary).toContain('Status: merged');
    expect(after.summary.endsWith(discussionOf(full.raw_text).slice(discussionOf(full.raw_text).lastIndexOf('\n\n## Comments')))).toBe(true);
    expect(after.summary).toContain('we chose Postgres');
  });

  it('a complete row that had NO discussion goes pending again when the item changes (new comments may exist)', async () => {
    await seedFull({ title: 'PR 1', comments: [] });
    await ingItem((await realShapes({ title: 'PR 1', state: 'closed', merged: true, comments: [] })).thin);
    expect(snap(PR1)).toMatchObject({ detail_pending: 1 });
    expect(snap(PR1).summary).toContain('Status: merged');
  });

  it('a row that is itself pending takes the new thin text (nothing richer to protect)', async () => {
    await ingItem((await realShapes({ title: 'PR 1', comments: [COMMENT] })).thin);
    await ingItem((await realShapes({ title: 'PR 1', state: 'closed', merged: true, comments: [] })).thin);
    expect(snap(PR1)).toMatchObject({ detail_pending: 1 });
    expect(snap(PR1).summary).toContain('Status: merged');
  });
});

describe('an attested (ratified) row keeps its text whatever arrives', () => {
  function ratify(url: string): void {
    const db = new DatabaseSync(dbPath);
    db.prepare(`UPDATE decisions SET ratified_at = '2026-10-01T00:00:00.000Z', ratified_by = 'me' WHERE source_url = ?`).run(url);
    db.close();
  }

  it('a rename and a merge on an attested row are not applied, and nothing is re-embedded', async () => {
    const { stored, full } = await seedFull();
    ratify(PR1);
    embedded.length = 0;
    await ingItem((await realShapes({ title: 'PR 1 renamed', state: 'closed', merged: true, comments: [] })).thin);
    expect(snap(PR1)).toMatchObject({ title: stored.title, summary: full.raw_text, vec: stored.vec });
    expect(embedded).toEqual([]);
  });

  it('review 8: a thin attested row stays pending when a full item arrives and the attested text is kept', async () => {
    const { thin, full } = await realShapes({ title: 'PR 1', comments: [COMMENT] });
    const db = createLocalDb(dbPath);
    try {
      const id = db.insertDecision({ title: 'PR 1', summary: thin.raw_text, sourceUrl: PR1, platform: 'github', keyed: true, detailPending: true });
      const raw = new DatabaseSync(dbPath);
      raw.prepare(`UPDATE decisions SET ratified_at = '2026-10-01T00:00:00.000Z' WHERE id = ?`).run(id);
      raw.close();
      db.insertDecision({ title: 'PR 1', summary: full.raw_text, sourceUrl: PR1, platform: 'github', keyed: true, detailPending: false });
      expect(db.getDecisionById(id)).toMatchObject({ summary: thin.raw_text });
      const check = new DatabaseSync(dbPath);
      const row = check.prepare('SELECT detail_pending FROM decisions WHERE id = ?').get(id) as { detail_pending: number };
      check.close();
      expect(row.detail_pending).toBe(1);
    } finally { db.close(); }
  });
});
