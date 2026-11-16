/**
 * MIRSAD import into the local graph. Test list:
 * 1. importing twice with an edited title updates one row (source_url mirsad://decisions/<id> is keyed)
 * 2. a link is confirmed as `align mark <newer> replaces <older>` does: a supersede judgement by this
 *    person plus a supersedes edge newer -> older at confidence 1, so the older reads as superseded
 * 3. confirming twice leaves one judgement and one edge
 * 4. a link whose decision is not in the graph is ignored, the others still land
 * 5. with no terminal nothing is written and the outcome says so (the guard `align mark ... replaces` has)
 * 6. an older decision a person ratified is refused and counted, and the rest still land
 */
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
import { createLocalDb } from '../lib/local-db.js';
import { parseMirsadExport } from '../lib/fetchers/mirsad.js';
import { confirmMirsadLinks } from '../lib/mirsad-links.js';
import { rmDir } from './helpers/rm-dir.js';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

const JUDGE = { judgeId: 'install-1', judgeLabel: 'me@example.com' };
const base = { description: 'd', status: 'accepted', made_by: 'o', made_at: '2026-11-16 17:14', supersedes: null, superseded_by: null, entities: [], reasons: [], evidence: [], alternatives_rejected: [], effects: [], outcomes: [] };
const dec = (id: number, extra: Record<string, unknown> = {}) => ({ ...base, id, title: `Decision ${id}`, ...extra });

let dir: string;
let dbPath: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-mirsad-')); dbPath = path.join(dir, 'graph.db'); });
afterEach(() => rmDir(dir));

async function importExport(exp: unknown[]) {
  const read = parseMirsadExport(JSON.stringify(exp));
  const c = createLocalGatewayClient(dbPath);
  try { await c.ingestBatch(read.items as never, { classify: false, keyed: true }); } finally { c.close(); }
  return read;
}
function q<T>(sql: string, ...args: string[]): T[] {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); }
}
const idOf = (n: number) => q<{ id: string }>('SELECT id FROM decisions WHERE source_url = ?', `mirsad://decisions/${n}`)[0]!.id;

describe('re-import', () => {
  it('updates the row when the title was edited, instead of adding one', async () => {
    await importExport([dec(1), dec(2)]);
    await importExport([{ ...dec(1), title: 'Decision 1, reworded' }, dec(2)]);
    const rows = q<{ title: string }>('SELECT title FROM decisions ORDER BY source_url');
    expect(rows.map((r) => r.title)).toEqual(['Decision 1, reworded', 'Decision 2']);
  });
});

describe('confirmed supersedes links', () => {
  const exp = [dec(1), dec(2, { supersedes: 1 }), dec(3, { supersedes: 99 })];

  it('records the link as a person marking "newer replaces older"', async () => {
    const { links } = await importExport(exp);
    const out = confirmMirsadLinks(dbPath, links, { judge: JUDGE, terminal: true });
    expect(out).toMatchObject({ confirmed: 1, unmatched: 0, refused: 0, needsTerminal: false });
    const edges = q<{ source_id: string; target_id: string; relation: string; confidence: number; id: string }>("SELECT * FROM decision_links WHERE relation = 'supersedes'");
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source_id: idOf(2), target_id: idOf(1), relation: 'supersedes', confidence: 1 });
    const j = q<{ kind: string; decision_id: string; counterpart_id: string; judge_id: string; via: string; id: string }>('SELECT * FROM local_judgements');
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ kind: 'supersede', decision_id: idOf(2), counterpart_id: idOf(1), judge_id: 'install-1', via: 'cli' });
    expect(edges[0]!.id).toBe(`mark:${j[0]!.id}`);
    const local = createLocalDb(dbPath);
    try { expect(local.isSuperseded(idOf(1))).toBe(true); expect(local.isSuperseded(idOf(2))).toBe(false); } finally { local.close(); }
  });

  it('is idempotent', async () => {
    const { links } = await importExport(exp);
    confirmMirsadLinks(dbPath, links, { judge: JUDGE, terminal: true });
    confirmMirsadLinks(dbPath, links, { judge: JUDGE, terminal: true });
    expect(q("SELECT 1 FROM decision_links WHERE relation = 'supersedes'")).toHaveLength(1);
    expect(q('SELECT 1 FROM local_judgements')).toHaveLength(1);
  });

  it('ignores a link whose decision is not in the graph and still writes the rest', async () => {
    await importExport([dec(1), dec(2)]);
    const out = confirmMirsadLinks(dbPath, [{ newer: 2, older: 1 }, { newer: 5, older: 1 }, { newer: 2, older: 6 }], { judge: JUDGE, terminal: true });
    expect(out).toMatchObject({ confirmed: 1, unmatched: 2 });
  });

  it('writes nothing without a terminal and says so', async () => {
    const { links } = await importExport(exp);
    const out = confirmMirsadLinks(dbPath, links, { judge: JUDGE, terminal: false });
    expect(out).toMatchObject({ confirmed: 0, needsTerminal: true });
    expect(q("SELECT 1 FROM decision_links WHERE relation = 'supersedes'")).toHaveLength(0);
    expect(q('SELECT 1 FROM local_judgements')).toHaveLength(0);
  });

  it('refuses to replace a decision a person ratified, counts it, and keeps going', async () => {
    await importExport([dec(1), dec(2, { supersedes: 1 }), dec(3), dec(4, { supersedes: 3 })]);
    const local = createLocalDb(dbPath);
    try { local.markRatified(idOf(1), 'someone'); } finally { local.close(); }
    const out = confirmMirsadLinks(dbPath, [{ newer: 2, older: 1 }, { newer: 4, older: 3 }], { judge: JUDGE, terminal: true });
    expect(out).toMatchObject({ confirmed: 1, refused: 1 });
    expect(q<{ target_id: string }>("SELECT target_id FROM decision_links WHERE relation = 'supersedes'").map((r) => r.target_id)).toEqual([idOf(3)]);
  });
});
