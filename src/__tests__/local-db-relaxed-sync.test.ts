import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalDb } from '../lib/local-db.js';

const row = (title: string) => ({ title, summary: title, sourceUrl: `https://x.test/${title}`, platform: 'git', repo: null, decidedAt: null, deciderKind: 'human' as const });

describe('LocalDb.withRelaxedSync', () => {
  it('returns what the callback returns and leaves each write committed on its own', async () => {
    const file = path.join(os.tmpdir(), `align-sync-${Date.now()}-${Math.random()}.db`);
    const db = createLocalDb(file);
    const out = await db.withRelaxedSync(async () => { db.insertDecision(row('one')); return 42; });
    expect(out).toBe(42);
    // another connection sees the row with the callback still finished: it was committed, not held
    const other = new DatabaseSync(file);
    expect((other.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n).toBe(1);
    other.close(); db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  });

  it('puts synchronous back to FULL after a throw, and rethrows', async () => {
    const db = createLocalDb(':memory:');
    await expect(db.withRelaxedSync(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(db.syncMode()).toBe(2);
    db.insertDecision(row('after'));
    expect(db.listDecisions().map(d => d.title)).toEqual(['after']);
  });

  it('is NORMAL inside the callback and FULL outside it', async () => {
    const file = path.join(os.tmpdir(), `align-sync2-${Date.now()}-${Math.random()}.db`);
    const db = createLocalDb(file);
    const read = () => db.syncMode();
    expect(read()).toBe(2);
    await db.withRelaxedSync(async () => { expect(read()).toBe(1); });
    expect(read()).toBe(2);
    db.close();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  });
});
