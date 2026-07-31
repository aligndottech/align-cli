import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDb } from '../lib/local-db.js';
import { DEMO_DECISIONS, DEMO_LINKS, seedDemoGraph } from '../lib/demo-seed.js';

// A fake embedder: the seed lib must not depend on the real MiniLM model for its
// structural behaviour (insert/embed/link). Any 384-length vector is fine here;
// retrieval FIDELITY (does "why gRPC" return the gRPC decision) is a real-model
// integration concern verified separately in Phase 0, not a unit test.
const fakeEmbed = async (text: string): Promise<Float32Array> =>
  new Float32Array(384).fill((text.length % 13) / 13);

describe('demo-seed', () => {
  let dbPath: string;
  let db: ReturnType<typeof createLocalDb> | undefined;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `align-demo-seed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('seeds every curated decision', async () => {
    db = createLocalDb(dbPath);
    await seedDemoGraph(db, fakeEmbed);
    expect(db.getStats().decisions).toBe(DEMO_DECISIONS.length);
  });

  it('embeds every seeded decision (beat 1 precondition)', async () => {
    db = createLocalDb(dbPath);
    await seedDemoGraph(db, fakeEmbed);
    expect(db.getStats().embeddings).toBe(DEMO_DECISIONS.length);
  });

  it('spans both slack and github platforms (cross-tool)', async () => {
    db = createLocalDb(dbPath);
    await seedDemoGraph(db, fakeEmbed);
    const platforms = new Set(db.listDecisions().map(d => d.platform));
    expect(platforms.has('slack')).toBe(true);
    expect(platforms.has('github')).toBe(true);
  });

  it('seeds NO conflicts - the conflict is the live proposed change, not pre-baked', async () => {
    db = createLocalDb(dbPath);
    await seedDemoGraph(db, fakeEmbed);
    expect(db.getStats().conflicts).toBe(0);
    expect(db.listLinks({ relation: 'conflicts_with' })).toHaveLength(0);
  });

  it('creates the curated refines link between the two related decisions', async () => {
    db = createLocalDb(dbPath);
    const ids = await seedDemoGraph(db, fakeEmbed);
    const refines = db.listLinks({ relation: 'refines' });
    expect(refines).toHaveLength(DEMO_LINKS.length);
    const link = DEMO_LINKS[0]!;
    expect(refines[0]!.sourceId).toBe(ids[link.from]);
    expect(refines[0]!.targetId).toBe(ids[link.to]);
  });

  it('leads with the synchronous gRPC decision and encodes who decided each one', () => {
    // Beat 1 must return a decision with rationale AND an author. The local schema
    // has no author column, so every summary has to carry the "who" in its text.
    expect(DEMO_DECISIONS[0]!.title.toLowerCase()).toContain('grpc');
    for (const d of DEMO_DECISIONS) {
      expect(d.summary.toLowerCase()).toMatch(/\bby\b/);
    }
  });
});
