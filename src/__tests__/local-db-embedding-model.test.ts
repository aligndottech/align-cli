/**
 * ALI-787: the `decision_embeddings.model` column - which HF model produced this vector.
 *
 * `decision_embeddings` had no model tag at all before this: every vector was silently
 * assumed to be Xenova/all-MiniLM-L6-v2, the only model this graph has ever embedded with
 * (verified against git history - no other model id was ever hardcoded in
 * local-embeddings.ts/local-embeddings-wasm.ts). ALI-787's evaluation did not adopt a
 * replacement model (see docs/embedding-model-evaluation.md), but a future swap needs this
 * column to avoid comparing two models' vectors as if they were compatible - same-length
 * float arrays from different models pass cosineSimilarity's length check and produce a
 * plausible, meaningless score.
 *
 * Test List:
 * 1. a fresh database's decision_embeddings table carries a `model` column, SCHEMA_VERSION >= 6
 * 2. a v5 graph (built by hand, no migrate()) gains the column on open, backfills every
 *    existing embedding row to the historical model constant, and stamps version 6
 * 3. setEmbedding(id, embedding, model) stores the given model; the 2-arg call stores NULL
 * 4. getEmbeddingModel(id) reads it back; null for an unknown id or an unset model
 * 5. getAllEmbeddings({ model }) excludes rows tagged with a different model; omitting the
 *    filter returns every row regardless of tag (backward compat with the repo-scope test)
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDb, SCHEMA_VERSION } from '../lib/local-db.js';

let dir: string;
let dbPath: string;
let db: ReturnType<typeof createLocalDb> | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-embedding-model-'));
  dbPath = path.join(dir, 'local.db');
});

afterEach(() => {
  db?.close();
  db = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function columnsOf(table: string): string[] {
  const raw = new DatabaseSync(dbPath);
  const cols = (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  raw.close();
  return cols;
}

describe('the decision_embeddings.model column', () => {
  it('is on a fresh database, and the schema is at least 6', () => {
    db = createLocalDb(dbPath);
    db.close();
    db = undefined;
    // Positive control: the table exists at all before asserting about its shape.
    expect(columnsOf('decision_embeddings')).toContain('embedding');
    expect(columnsOf('decision_embeddings')).toContain('model');
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
  });

  it('is added to a v5 graph on open, and every existing embedding is backfilled to Xenova/all-MiniLM-L6-v2', () => {
    // The v5 shape by hand: everything up to the provenance columns, no `model` on embeddings.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, source_url TEXT,
        platform TEXT NOT NULL DEFAULT 'cli', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        repo TEXT, decided_at TEXT, decider_kind TEXT, confirmed_by TEXT, confirmed_at TEXT,
        ratified_by TEXT, ratified_at TEXT
      );
      CREATE TABLE decision_embeddings (decision_id TEXT PRIMARY KEY, embedding BLOB NOT NULL);
      CREATE TABLE decision_links (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE decision_refs (decision_id TEXT NOT NULL, ref TEXT NOT NULL, platform TEXT NOT NULL, PRIMARY KEY (decision_id, ref));
      CREATE TABLE decision_audit (id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE UNIQUE INDEX decisions_source_title_unique ON decisions(source_url, title);
      CREATE UNIQUE INDEX decision_links_triple_unique ON decision_links(source_id, target_id, relation);
      PRAGMA user_version = 5;
    `);
    raw.prepare('INSERT INTO decisions (id, title, summary, source_url, platform) VALUES (?, ?, ?, ?, ?)')
      .run('d1', 'Pre-existing row', 's', 'https://github.com/acme/api/commit/abc1234', 'git');
    raw.prepare('INSERT INTO decision_embeddings (decision_id, embedding) VALUES (?, ?)')
      .run('d1', Buffer.from(new Float32Array(384).fill(0.2).buffer));
    raw.close();
    // Control on the fixture: it really is a v5 shape, so the column below is ADDED, not found.
    expect(columnsOf('decision_embeddings')).not.toContain('model');

    db = createLocalDb(dbPath);
    expect(db.getEmbeddingModel('d1')).toBe('Xenova/all-MiniLM-L6-v2');
    // The vector itself is untouched by the migration - only the tag is new.
    expect(db.getEmbedding('d1')?.length).toBe(384);
    db.close();
    db = undefined;

    expect(columnsOf('decision_embeddings')).toContain('model');
    const check = new DatabaseSync(dbPath);
    const version = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    check.close();
    expect(version).toBe(SCHEMA_VERSION);
  });
});

describe('setEmbedding / getEmbeddingModel', () => {
  it('stores the given model and reads it back', () => {
    db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 'T', summary: 'S', sourceUrl: null, platform: 'cli' });
    db.setEmbedding(id, new Float32Array(384).fill(0.1), 'Xenova/bge-small-en-v1.5');
    expect(db.getEmbeddingModel(id)).toBe('Xenova/bge-small-en-v1.5');
  });

  it('stores NULL when the caller omits the model, which reads as unknown', () => {
    db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 'T', summary: 'S', sourceUrl: null, platform: 'cli' });
    db.setEmbedding(id, new Float32Array(384).fill(0.1));
    expect(db.getEmbeddingModel(id)).toBeNull();
  });

  it('returns null for a decision with no embedding at all', () => {
    db = createLocalDb(':memory:');
    const id = db.insertDecision({ title: 'T', summary: 'S', sourceUrl: null, platform: 'cli' });
    expect(db.getEmbeddingModel(id)).toBeNull();
  });

  it('returns null for an id the graph does not hold', () => {
    db = createLocalDb(':memory:');
    expect(db.getEmbeddingModel('nope')).toBeNull();
  });
});

describe('getAllEmbeddings({ model }) filters by tag', () => {
  it('excludes a row tagged with a different model', () => {
    db = createLocalDb(':memory:');
    const current = db.insertDecision({ title: 'Current', summary: 's', sourceUrl: null, platform: 'cli' });
    const stale = db.insertDecision({ title: 'Stale', summary: 's', sourceUrl: null, platform: 'cli' });
    db.setEmbedding(current, new Float32Array([1, 0, 0]), 'Xenova/all-MiniLM-L6-v2');
    db.setEmbedding(stale, new Float32Array([1, 0, 0]), 'Xenova/bge-small-en-v1.5');

    const filtered = db.getAllEmbeddings({ model: 'Xenova/all-MiniLM-L6-v2' });
    expect(filtered.map((e) => e.decisionId)).toEqual([current]);
  });

  it('omitting the model filter returns every row regardless of tag (backward compat)', () => {
    db = createLocalDb(':memory:');
    const a = db.insertDecision({ title: 'A', summary: 's', sourceUrl: null, platform: 'cli' });
    const b = db.insertDecision({ title: 'B', summary: 's', sourceUrl: null, platform: 'cli' });
    db.setEmbedding(a, new Float32Array([1, 0, 0]), 'Xenova/all-MiniLM-L6-v2');
    db.setEmbedding(b, new Float32Array([1, 0, 0]), 'Xenova/bge-small-en-v1.5');

    const all = db.getAllEmbeddings();
    expect(all.map((e) => e.decisionId).sort()).toEqual([a, b].sort());
  });

  it('composes with the repo filter', () => {
    db = createLocalDb(':memory:');
    const inRepo = db.insertDecision({ title: 'A', summary: 's', sourceUrl: 'https://github.com/acme/api/pull/1', platform: 'github', repo: 'github.com/acme/api' });
    const staleInRepo = db.insertDecision({ title: 'B', summary: 's', sourceUrl: 'https://github.com/acme/api/pull/2', platform: 'github', repo: 'github.com/acme/api' });
    db.setEmbedding(inRepo, new Float32Array([1, 0, 0]), 'Xenova/all-MiniLM-L6-v2');
    db.setEmbedding(staleInRepo, new Float32Array([1, 0, 0]), 'Xenova/bge-small-en-v1.5');

    const filtered = db.getAllEmbeddings({ repo: 'github.com/acme/api', model: 'Xenova/all-MiniLM-L6-v2' });
    expect(filtered.map((e) => e.decisionId)).toEqual([inRepo]);
  });
});
